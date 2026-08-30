import { test } from 'node:test';
import assert from 'node:assert/strict';

// Aísla los módulos de dependencias externas: sin Redis/Postgres reales y con clave de cifrado de prueba.
// Se define ANTES de importar (dinámicamente) los módulos que leen config al cargarse.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.TOKEN_ENC_KEY =
  process.env.TOKEN_ENC_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { encryptToken, decryptToken } = await import('../src/store/tokenCrypto');
const { createSemaphore, createKeyedLock } = await import('../src/util/concurrency');
const { redactPII } = await import('../src/obs/redact');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('tokenCrypto: roundtrip + passthrough + no re-cifra', () => {
  const secret = 'token_secreto_123';
  const enc = encryptToken(secret)!;
  assert.ok(enc.startsWith('enc:v1:'));
  assert.equal(decryptToken(enc), secret);
  assert.equal(decryptToken('texto_plano'), 'texto_plano');
  assert.equal(encryptToken(enc), enc);
});

test('redactPII: enmascara email y teléfono preservando estructura', () => {
  const out: any = redactPII({
    msg: 'escríbeme a juan.perez@gmail.com o al +56912345678',
    nested: ['móvil 56987654321', { tel: '+56911112222' }],
    score: 80,
  });
  assert.ok(!JSON.stringify(out).includes('juan.perez@gmail.com'));
  assert.ok(!JSON.stringify(out).includes('56912345678'));
  assert.ok(!JSON.stringify(out).includes('56987654321'));
  assert.equal(out.score, 80, 'no toca campos no sensibles');
});

test('createKeyedLock: serializa la misma clave', async () => {
  const lock = createKeyedLock();
  const order: string[] = [];
  const t = (id: string, ms: number) =>
    lock('K', async () => {
      order.push('s' + id);
      await sleep(ms);
      order.push('e' + id);
    });
  await Promise.all([t('1', 20), t('2', 5)]);
  assert.deepEqual(order, ['s1', 'e1', 's2', 'e2']);
});

test('createSemaphore: no supera el máximo de concurrencia', async () => {
  const sem = createSemaphore(2);
  let c = 0,
    m = 0;
  const t = () =>
    sem(async () => {
      c++;
      m = Math.max(m, c);
      await sleep(10);
      c--;
    });
  await Promise.all([t(), t(), t(), t()]);
  assert.equal(m, 2);
});
