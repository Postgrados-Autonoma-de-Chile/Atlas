import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Test de integración del bucle del agente (runAgentTurn): razonamiento + tool-calling + memoria.
// Mockea SOLO el cliente Anthropic (../src/ai/client) para no tocar la red; el resto corre real:
// el ejecutor de tools (stub de Fase 1), la memoria en Redis-modo-memoria y las métricas.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

// `impl` es la implementación programable de anthropic.messages.create para cada test.
let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: '' }], usage: {} });

mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => impl(args) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { runAgentTurn } = await import('../src/ai/agentLoop');
const { getHistory } = await import('../src/ai/memory');
const { TUTOR_WHATSAPP_PROFILE } = await import('../src/core/channel');

const ctx = () => ({ conversationId: '', profile: TUTOR_WHATSAPP_PROFILE }) as any;

const textResp = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 7 } });
const toolResp = (id: string, name: string, input: any) => ({ content: [{ type: 'tool_use', id, name, input }], usage: {} });

test('caché: dos breakpoints — el prefijo estable Y el historial', async () => {
  // El prefijo estable (system + tools) se marca explícitamente; el historial lo cubre el
  // breakpoint automático de nivel superior. Sin el segundo, los mensajes se reenvían a precio
  // completo en cada llamada: era el 47% de la factura del piloto.
  let visto: any = null;
  impl = async (args: any) => (visto = args, textResp('ok'));
  await runAgentTurn({ ...ctx(), conversationId: 'al-cache' }, 'hola');

  assert.deepEqual(visto.cache_control, { type: 'ephemeral' }, 'breakpoint automático sobre los mensajes');
  assert.deepEqual(
    visto.system[0].cache_control, { type: 'ephemeral' },
    'el prefijo estable conserva su marca explícita',
  );
  // Ambos con el TTL por defecto: una marca explícita en el ÚLTIMO bloque con TTL distinto del
  // de nivel superior es un 400 documentado. Aquí la explícita va en system, no en el último.
  assert.equal('ttl' in visto.cache_control, false);
  assert.equal('ttl' in visto.system[0].cache_control, false);
});

test('caché: el breakpoint sigue puesto en la segunda llamada del turno (la del tool_result)', async () => {
  // Es donde más rinde: la segunda llamada reenvía todo el contexto más el resultado de la tool.
  // `messages` se muta en sitio y viaja por referencia, así que hay que quedarse con el largo
  // EN EL MOMENTO de cada llamada; guardar el objeto daría dos vistas del mismo array final.
  const llamadas: { cacheControl: any; nMensajes: number }[] = [];
  let paso = 0;
  impl = async (args: any) => {
    llamadas.push({ cacheControl: args.cache_control, nMensajes: args.messages.length });
    return paso++ === 0 ? toolResp('t1', 'consultar_progreso', {}) : textResp('listo');
  };
  await runAgentTurn({ ...ctx(), conversationId: 'al-cache-2' }, 'como voy');

  assert.equal(llamadas.length, 2, 'un tool_use produce dos llamadas');
  for (const [i, c] of llamadas.entries()) {
    assert.deepEqual(c.cacheControl, { type: 'ephemeral' }, `llamada ${i + 1} sin breakpoint`);
  }
  assert.ok(llamadas[1].nMensajes > llamadas[0].nMensajes, 'la segunda reenvía más historial');
});

test('runAgentTurn: respuesta de solo texto se devuelve y se guarda en memoria', async () => {
  impl = async () => textResp('¡Hola! Soy ATLAS, tu tutor. ¿En qué te ayudo?');
  const c = { ...ctx(), conversationId: 'al-text' };
  const reply = await runAgentTurn(c, 'hola');
  assert.equal(reply, '¡Hola! Soy ATLAS, tu tutor. ¿En qué te ayudo?');
  const hist = await getHistory('al-text');
  assert.ok(hist.length >= 2, 'guarda el turno del usuario y del asistente en la memoria');
});

test('runAgentTurn: un tool_use se ejecuta y su resultado se realimenta al modelo', async () => {
  const seen: any[] = [];
  let step = 0;
  impl = async (args: any) => {
    seen.push(args);
    step++;
    if (step === 1) return toolResp('tu1', 'tool_de_prueba_inexistente', { texto: 'fotosíntesis' });
    return textResp('Ese contenido aún no está cargado en la plataforma.');
  };
  const reply = await runAgentTurn({ ...ctx(), conversationId: 'al-tool' }, '¿qué es la fotosíntesis?');
  assert.equal(reply, 'Ese contenido aún no está cargado en la plataforma.');
  assert.equal(step, 2, 'llama al modelo 2 veces: decide la tool y luego responde');
  // El segundo prompt al modelo debe incluir el tool_result de la ejecución (stub de Fase 1 → ok:false).
  const secondCallMsgs = seen[1].messages;
  const toolResults = secondCallMsgs
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((b: any) => b.type === 'tool_result');
  assert.equal(toolResults.length, 1, 'el resultado de la tool se realimenta al modelo');
  assert.match(String(toolResults[0].content), /tool_no_implementada/);
});

test('runAgentTurn: guardrail anti-bucle corta a los 5 pasos con mensaje de respaldo', async () => {
  let step = 0;
  impl = async () => {
    step++;
    return toolResp('tu' + step, 'buscar_contenido_curso', { texto: 'x' }); // nunca devuelve texto
  };
  const reply = await runAgentTurn({ ...ctx(), conversationId: 'al-loop' }, 'dame info');
  assert.equal(step, 5, 'respeta el tope de MAX_STEPS');
  assert.match(reply, /plantearla de otra forma/i, 'cae al mensaje de respaldo del motor');
});

test('runAgentTurn: error del modelo devuelve mensaje de fallback (no revienta)', async () => {
  impl = async () => {
    throw new Error('boom de la API');
  };
  const reply = await runAgentTurn({ ...ctx(), conversationId: 'al-error' }, 'hola');
  assert.match(reply, /inconveniente técnico/i);
});
