import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Bug real de producción (17-21 sep 2026): la VM atlas-redis quedó apagada 4 días. Con el KV
// inalcanzable, `getJson(KEY(waId))` devolvía null para TODO el mundo — gente nueva y gente a
// mitad de registro por igual — y el flujo lo interpretaba como "primer contacto": reenviaba el
// consentimiento en cada mensaje, sin parar. ~500 mensajes en 4 días, cero registros completados.
//
// Esta prueba fija el contrato que lo evita: sin poder LEER el estado (kv caído de verdad, no
// "esta persona no tiene fila"), el asistente NO responde nada — se queda fail-closed y deja que
// el mensaje siga su curso — en vez de reiniciar un flujo que puede estar a mitad de camino.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

mock.module('../src/store/db.ts', {
  namedExports: {
    dbEnabled: () => true,
    dbInsertAudit: async () => {},
    getPool: () => null,
  },
});

mock.module('../src/store/personas.ts', {
  namedExports: {
    buscarPersonaPorWaId: async () => null, // nadie registrado: es lo que abre el flujo
    crearPersonaRegistrada: async () => ({ id: 'p-1' }),
    registrarOptOut: async () => true,
  },
});

// El corazón de la prueba: un KV que SIEMPRE devuelve null (como si la clave no existiera) y un
// interruptor para decidir si Redis está vivo. `getEstado` en registro.ts tiene que distinguir
// las dos situaciones consultando kvVivo() cuando la lectura viene vacía.
let redisVivo = true;
mock.module('../src/store/kv.ts', {
  namedExports: {
    getJson: async () => null,
    setJson: async () => {},
    kvDel: async () => {},
    kvGet: async () => null,
    kvSet: async () => {},
    once: async () => true,
    kvKind: 'redis',
    getRedisClient: () => null,
    kvVivo: async () => redisVivo,
  },
});

const { manejarRegistro } = await import('../src/flows/registro');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };

function fakeProvider() {
  const textos: string[] = [];
  const botones: { cuerpo: string; ids: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake',
    configurado: () => true,
    enviarTexto: async (_to, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async (_to, cuerpo, bs) => (botones.push({ cuerpo, ids: bs.map((b) => b.id) }), OK),
    enviarLista: async () => OK,
    enviarDocumento: async () => OK,
    marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, textos, botones };
}

let n = 0;
const texto = (from: string, t: string): InboundMessage =>
  ({ waMessageId: 'wamid.rk' + ++n, from, timestamp: new Date(), type: 'text', text: t });

test('Redis caído: NO reenvía el consentimiento — se queda fail-closed', async () => {
  redisVivo = false;
  const { p, textos, botones } = fakeProvider();
  const r = await manejarRegistro(texto('+56911110001', 'hola'), p);

  assert.equal(r.handled, false, 'no puede secuestrar el mensaje con un flujo que no puede verificar');
  assert.equal(r.persona, null);
  assert.equal(botones.length, 0, 'no se reenvía el botón de consentimiento');
  assert.equal(textos.length, 0, 'ningún mensaje sale hacia esta persona');
});

test('Redis caído, dos mensajes seguidos: sigue sin responder (esto es lo que se volvió un bucle)', async () => {
  redisVivo = false;
  const { p, botones } = fakeProvider();
  await manejarRegistro(texto('+56911110002', 'hola'), p);
  await manejarRegistro(texto('+56911110002', 'Acepto'), p);
  assert.equal(botones.length, 0, 'ni el primer ni el segundo mensaje disparan el consentimiento');
});

test('Redis sano y persona de verdad nueva: el consentimiento SÍ se envía (no se rompió el camino feliz)', async () => {
  redisVivo = true;
  const { p, botones } = fakeProvider();
  const r = await manejarRegistro(texto('+56911110003', 'hola'), p);

  assert.equal(r.handled, true);
  assert.equal(botones.length, 1);
  assert.deepEqual(botones[0].ids, ['reg_si', 'reg_no']);
});
