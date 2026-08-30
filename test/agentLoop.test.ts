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
    if (step === 1) return toolResp('tu1', 'buscar_contenido_curso', { texto: 'fotosíntesis' });
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
