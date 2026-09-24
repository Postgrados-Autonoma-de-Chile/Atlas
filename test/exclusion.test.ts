import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// EXCLUSIÓN DE PERSONAS (24-09-2026).
//
// Dirección pidió que ATLAS dejara de escribirle y de responderle a las personas que aparecen en
// Bitrix24. Se implementó como marca reversible (person.excluido_at), no como borrado: borrar no
// consigue el efecto —la persona vuelve a escribir, ATLAS no la reconoce y le arranca el registro,
// o sea le responde igual— y además destruye consentimiento, avance y el respaldo de certificados
// ya emitidos.
//
// Lo que estos tests fijan es el orden: la exclusión calla TODO menos la señal de riesgo vital, que
// se atiende igual porque el motivo de la exclusión es de canal comercial y no alcanza para eso.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_PROVIDER = '';

let excluidos = new Set<string>();
let bienestarIntercepta = false;

mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: 'respuesta del tutor' }], usage: {} }) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

// mock.module reemplaza el módulo ENTERO: hay que reponer todo lo que se use, no solo estaExcluido.
mock.module('../src/store/personas.ts', {
  namedExports: {
    estaExcluido: async (waId: string) => excluidos.has(waId),
    buscarPersonaPorWaId: async () => null,
    crearPersonaRegistrada: async () => null,
    registrarOptOut: async () => true,
    registrarOptIn: async () => true,
    tieneRut: async () => false,
    guardarRut: async () => 'ok',
    marcarEmailVerificado: async () => {},
  },
});

mock.module('../src/flows/bienestar.ts', {
  namedExports: {
    manejarBienestar: async (_m: any, provider: any) => {
      if (!bienestarIntercepta) return { handled: false };
      await provider.enviarTexto('+56900000009', 'contención: acá tienes ayuda');
      return { handled: true };
    },
  },
});

const { procesarMensajeEntrante } = await import('../src/routes/whatsapp');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true, messageId: 'wamid.out' };

function fakeProvider() {
  const enviados: { to: string; texto: string }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (to, texto) => (enviados.push({ to, texto }), OK),
    enviarPlantilla: async () => OK, enviarBotones: async () => OK, enviarLista: async () => OK,
    enviarDocumento: async () => OK, marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, enviados };
}

let seq = 0;
const msg = (over: Partial<InboundMessage>): InboundMessage => ({
  waMessageId: `wamid.excl${++seq}`,
  from: '+56900000009',
  timestamp: new Date(),
  type: 'text',
  text: 'hola',
  ...over,
});

const reset = () => { excluidos = new Set(); bienestarIntercepta = false; };

test('persona excluida: ATLAS no responde nada, ni siquiera un acuse', async () => {
  reset();
  excluidos.add('+56900000009');
  const { p, enviados } = fakeProvider();

  await procesarMensajeEntrante(msg({}), p);

  // Silencio completo a propósito: cualquier respuesta, aunque fuera "no puedo atenderte", reabre
  // la conversación que la exclusión busca cerrar.
  assert.equal(enviados.length, 0);
});

test('persona NO excluida: el flujo sigue normal', async () => {
  reset();
  const { p, enviados } = fakeProvider();

  await procesarMensajeEntrante(msg({}), p);

  assert.ok(enviados.length > 0, 'quien no está excluida sigue siendo atendida');
});

test('la exclusión no tapa una señal de riesgo vital', async () => {
  reset();
  excluidos.add('+56900000009');
  bienestarIntercepta = true;
  const { p, enviados } = fakeProvider();

  await procesarMensajeEntrante(msg({ text: 'tengo pensamientos suicidas' }), p);

  // El motivo de la exclusión es no pisar una gestión comercial. Callar ante esto no tiene nada que
  // ver con ese motivo, y atenderlo no interfiere con ninguna venta.
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].texto, /contención/);
});

test('la exclusión es por número: no alcanza a quien no está en la lista', async () => {
  reset();
  excluidos.add('+56900000009');
  const { p, enviados } = fakeProvider();

  await procesarMensajeEntrante(msg({ from: '+56900000010' }), p);

  assert.ok(enviados.length > 0);
  assert.equal(enviados[0].to, '+56900000010');
});
