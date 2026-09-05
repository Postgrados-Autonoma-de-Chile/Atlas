import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Pipeline del canal WhatsApp (Fase 10a): dedupe por wamid, ruteo por tipo de mensaje, turno del
// motor (Anthropic mockeado) y respuesta por el MessagingProvider (falso, sin red).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_PROVIDER = '';
process.env.DEEPGRAM_API_KEY = ''; // audio → sin transcripción → fallback

let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: 'respuesta del tutor' }], usage: {} });

mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => impl(args) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { procesarMensajeEntrante } = await import('../src/routes/whatsapp');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true, messageId: 'wamid.out' };

function fakeProvider() {
  const enviados: { to: string; texto: string }[] = [];
  const leidos: string[] = [];
  const p: MessagingProvider = {
    nombre: 'fake',
    configurado: () => true,
    enviarTexto: async (to, texto) => (enviados.push({ to, texto }), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async () => OK,
    enviarLista: async () => OK,
    enviarDocumento: async () => OK,
    marcarLeido: async (id) => (leidos.push(id), OK),
    descargarMedia: async () => ({ base64: Buffer.from('audio-fake').toString('base64'), mediaType: 'audio/ogg' }),
  };
  return { p, enviados, leidos };
}

const msg = (over: Partial<InboundMessage>): InboundMessage => ({
  waMessageId: 'wamid.' + Math.random().toString(36).slice(2),
  from: '+56912345678',
  timestamp: new Date(),
  type: 'text',
  text: 'hola',
  ...over,
});

test('texto: procesa el turno y responde por el provider (y marca leído)', async () => {
  impl = async () => ({ content: [{ type: 'text', text: '¡Hola! Soy ATLAS.' }], usage: {} });
  const { p, enviados, leidos } = fakeProvider();
  const m = msg({ from: '+56900000001', waMessageId: 'wamid.t1' });
  await procesarMensajeEntrante(m, p);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, '+56900000001');
  assert.equal(enviados[0].texto, '¡Hola! Soy ATLAS.');
  assert.deepEqual(leidos, ['wamid.t1']);
});

test('dedupe: el mismo wamid solo se procesa una vez (Meta reintenta)', async () => {
  impl = async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} });
  const { p, enviados } = fakeProvider();
  const m = msg({ from: '+56900000002', waMessageId: 'wamid.dup' });
  await procesarMensajeEntrante(m, p);
  await procesarMensajeEntrante({ ...m }, p);
  assert.equal(enviados.length, 1, 'el duplicado no genera segundo turno ni segunda respuesta');
});

test('interactivo: el título elegido llega como texto del turno', async () => {
  let visto = '';
  impl = async (args: any) => {
    visto = args.messages.at(-1).content;
    return { content: [{ type: 'text', text: 'correcto' }], usage: {} };
  };
  const { p } = fakeProvider();
  await procesarMensajeEntrante(
    msg({ from: '+56900000003', type: 'interactive', text: undefined, interactiveReplyId: 'v', interactiveReplyTitle: 'Verdadero' }),
    p,
  );
  assert.equal(visto, 'Verdadero');
});

test('audio sin transcripción: el motor recibe la instrucción de pedir texto', async () => {
  let visto = '';
  impl = async (args: any) => {
    visto = String(args.messages.at(-1).content);
    return { content: [{ type: 'text', text: '¿Me lo escribes?' }], usage: {} };
  };
  const { p, enviados } = fakeProvider();
  await procesarMensajeEntrante(msg({ from: '+56900000004', type: 'audio', text: undefined, mediaId: 'MEDIA9' }), p);
  assert.match(visto, /audio que no se pudo transcribir/);
  assert.equal(enviados.length, 1);
});

test('imagen: el turno lleva bloques de visión (texto + imagen base64)', async () => {
  let bloques: any[] = [];
  impl = async (args: any) => {
    bloques = args.messages.at(-1).content;
    return { content: [{ type: 'text', text: 'veo un ejercicio' }], usage: {} };
  };
  const { p } = fakeProvider();
  await procesarMensajeEntrante(msg({ from: '+56900000005', type: 'image', text: '¿me ayudas con esto?', mediaId: 'IMG1' }), p);
  assert.ok(Array.isArray(bloques));
  assert.equal(bloques[0].type, 'text');
  assert.equal(bloques[0].text, '¿me ayudas con esto?');
  assert.equal(bloques[1].type, 'image');
  assert.equal(bloques[1].source.media_type, 'audio/ogg'); // el fake devuelve ese mime; lo que importa es el passthrough
});

test('tipo desconocido: se ignora sin responder', async () => {
  const { p, enviados } = fakeProvider();
  await procesarMensajeEntrante(msg({ from: '+56900000006', type: 'unknown', text: undefined }), p);
  assert.equal(enviados.length, 0);
});

test('sin remitente o sin wamid: se descarta sin efectos', async () => {
  const { p, enviados } = fakeProvider();
  await procesarMensajeEntrante(msg({ from: '' }), p);
  await procesarMensajeEntrante(msg({ waMessageId: '' }), p);
  assert.equal(enviados.length, 0);
});
