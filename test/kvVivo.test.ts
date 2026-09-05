import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// PING real en el healthcheck.
//
// Al conectar Redis en el despliegue del piloto quedó a la vista que /health informaba
// kv: "redis" sin comprobar nada: `kvKind` se fija al CONSTRUIR el cliente y `new Redis(...)` no
// lanza cuando la conexión falla — ioredis reintenta callado en segundo plano. Es decir, el
// healthcheck habría dicho "todo bien" con Redis inalcanzable.

process.env.REDIS_URL = 'redis://falso:6379';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let ping: () => Promise<string> = async () => 'PONG';

class RedisFalso {
  constructor(_url?: string, _opts?: unknown) {}
  on() { return this; }
  ping() { return ping(); }
}

mock.module('ioredis', { defaultExport: RedisFalso });

const { kvVivo, kvKind } = await import('../src/store/kv');

test('con REDIS_URL el backend es redis', () => {
  assert.equal(kvKind, 'redis');
});

test('responde PONG: está vivo', async () => {
  ping = async () => 'PONG';
  assert.equal(await kvVivo(), true);
});

test('la conexión falla: está caído (no lanza hacia el handler)', async () => {
  ping = async () => { throw new Error('ECONNREFUSED 10.142.0.2:6379'); };
  assert.equal(await kvVivo(), false);
});

test('responde cualquier otra cosa: se considera caído', async () => {
  ping = async () => 'LOADING Redis is loading the dataset in memory';
  assert.equal(await kvVivo(), false);
});

test('Redis no contesta: corta a los 2 s en vez de colgar el healthcheck', async () => {
  ping = () => new Promise(() => {}); // jamás resuelve
  // El temporizador de corte de kvVivo() está unref'd a propósito: un healthcheck no debe
  // retrasar el cierre del proceso. Bajo el runner eso deja el event loop sin nada que lo
  // sostenga —el PING nunca vuelve— y node:test aborta el test antes de su aserción
  // ('cancelledByParent'). Este temporizador sí referenciado lo mantiene vivo los 2 s que dura
  // la medición, y se limpia enseguida para no retener el proceso.
  const sosten = setTimeout(() => {}, 5000);
  const t0 = Date.now();
  const vivo = await kvVivo();
  const ms = Date.now() - t0;
  clearTimeout(sosten);
  assert.equal(vivo, false, 'un PING que nunca vuelve significa caído');
  assert.ok(ms >= 1900 && ms < 3500, `debe cortar cerca de los 2 s, tardó ${ms} ms`);
});
