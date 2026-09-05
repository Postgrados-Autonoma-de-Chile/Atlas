import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Fuga de etiquetas internas al texto del estudiante.
//
// Modo de falla real, visto en el piloto por WhatsApp: con el thinking DESACTIVADO, esta familia de
// modelos a veces escribe la llamada a herramienta como texto visible en vez de emitir un bloque
// tool_use. El turno termina sin error, ningún log lo registra, la herramienta nunca corre — y al
// estudiante le llega XML crudo. Literalmente llegó esto:
//
//     <invoke name="continuar_curso"></invoke>
//
// La causa se corrige en el perfil (thinking: 'adaptive', ver core/channel.ts). Estos tests cubren
// la red de último metro: aunque el modelo se equivoque, la etiqueta no sale hacia la persona.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: '' }], usage: {} });

mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => impl(args) } },
    REASONER: 'claude-test',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { limpiarEtiquetasInternas, runAgentTurn } = await import('../src/ai/agentLoop');
const { TUTOR_WHATSAPP_PROFILE } = await import('../src/core/channel');

test('limpia el caso exacto que llegó al estudiante', () => {
  assert.equal(limpiarEtiquetasInternas('<invoke name="continuar_curso">\n</invoke>'), '');
});

test('conserva el texto útil y quita solo la etiqueta', () => {
  const r = limpiarEtiquetasInternas('Dale, te la entrego.\n<invoke name="continuar_curso"></invoke>');
  assert.equal(r, 'Dale, te la entrego.');
});

test('limpia variantes con prefijo y con parámetros', () => {
  assert.equal(limpiarEtiquetasInternas('<invoke name="evaluar"></invoke>'), '');
  assert.equal(limpiarEtiquetasInternas('hola <function_calls> chao').replace(/\s+/g, ' '), 'hola chao');
});

test('quita etiquetas de thinking filtradas', () => {
  assert.equal(limpiarEtiquetasInternas('<thinking>me lo pienso</thinking>Hola'), 'me lo piensoHola');
});

test('no toca un texto normal, ni el que menciona una herramienta en prosa', () => {
  const normal = 'Vas en la microcápsula 2 de 9. ¿Seguimos?';
  assert.equal(limpiarEtiquetasInternas(normal), normal);
  const prosa = 'Cuando termines te marco el avance con la herramienta de progreso.';
  assert.equal(limpiarEtiquetasInternas(prosa), prosa);
});

test('tolera null, undefined y vacío', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(limpiarEtiquetasInternas(v as any), '');
});

test('el motor NUNCA devuelve una etiqueta cruda, aunque el modelo la escriba', async () => {
  impl = async () => ({
    content: [{ type: 'text', text: 'Perfecto.\n<invoke name="continuar_curso"></invoke>' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const reply = await runAgentTurn(
    { profile: TUTOR_WHATSAPP_PROFILE, conversationId: 'fuga-1' } as any,
    'sí',
  );
  assert.doesNotMatch(reply, /<\/?invoke/i, 'la etiqueta no puede llegar al estudiante');
  assert.equal(reply, 'Perfecto.');
});

test('si la respuesta era SOLO la etiqueta, cae al mensaje de respaldo, no a vacío', async () => {
  impl = async () => ({
    content: [{ type: 'text', text: '<invoke name="continuar_curso"></invoke>' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const reply = await runAgentTurn(
    { profile: TUTOR_WHATSAPP_PROFILE, conversationId: 'fuga-2' } as any,
    'sí',
  );
  assert.ok(reply.length > 0, 'mandar un mensaje vacío por WhatsApp sería peor que el respaldo');
  assert.doesNotMatch(reply, /<\/?invoke/i);
});

test('el perfil de WhatsApp NO usa thinking desactivado', () => {
  // Es la causa raíz. Volver a 'disabled' reintroduce la fuga.
  assert.notEqual(TUTOR_WHATSAPP_PROFILE.thinking, 'disabled');
  assert.ok(
    TUTOR_WHATSAPP_PROFILE.maxResponseTokens >= 2048,
    'con thinking activo el razonamiento consume del mismo presupuesto: un tope bajo trunca respuestas',
  );
});
