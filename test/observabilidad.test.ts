import { test } from 'node:test';
import assert from 'node:assert/strict';

// Observabilidad (F13): formateador de logs (JSON para Cloud Logging / texto dev) y costo LLM.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { formatearLinea, resolverFormato } = await import('../src/log');
const { costoEstimadoUsd, recordTokens, snapshot } = await import('../src/obs/metrics');

test('resolverFormato: json en producción, texto en dev, LOG_FORMAT manda', () => {
  assert.equal(resolverFormato({ NODE_ENV: 'production' }), 'json');
  assert.equal(resolverFormato({ NODE_ENV: 'test' }), 'text');
  assert.equal(resolverFormato({}), 'text');
  assert.equal(resolverFormato({ NODE_ENV: 'test', LOG_FORMAT: 'json' }), 'json');
  assert.equal(resolverFormato({ NODE_ENV: 'production', LOG_FORMAT: 'text' }), 'text');
});

test('formatearLinea json: severity de Cloud Logging + message + meta + time', () => {
  const linea = formatearLinea('json', 'warn', 'algo pasó', { reqId: 'r1', n: 2 });
  const obj = JSON.parse(linea);
  assert.equal(obj.severity, 'WARNING');
  assert.equal(obj.message, 'algo pasó');
  assert.equal(obj.reqId, 'r1');
  assert.equal(obj.n, 2);
  assert.ok(!Number.isNaN(Date.parse(obj.time)));
  assert.equal(JSON.parse(formatearLinea('json', 'error', 'x', {})).severity, 'ERROR');
  assert.equal(JSON.parse(formatearLinea('json', 'info', 'x', {})).severity, 'INFO');
});

test('formatearLinea text: una línea legible con meta JSON', () => {
  assert.equal(formatearLinea('text', 'info', 'hola', {}), 'INFO hola');
  assert.equal(formatearLinea('text', 'error', 'falló', { a: 1 }), 'ERROR falló {"a":1}');
});

test('costoEstimadoUsd: pondera input, output y caché por MTok', () => {
  const precios = { inUsd: 2, outUsd: 10, cacheWriteUsd: 2.5, cacheReadUsd: 0.2 };
  // 1M de cada tipo → 2 + 10 + 2.5 + 0.2 = 14.7 USD
  assert.equal(
    costoEstimadoUsd({ tokens_in: 1_000_000, tokens_out: 1_000_000, tokens_cache_write: 1_000_000, tokens_cache_read: 1_000_000 }, precios),
    14.7,
  );
  // Conversación típica con caché: 500 in nuevos + 2000 leídos de caché + 350 out
  const conv = costoEstimadoUsd({ tokens_in: 500, tokens_out: 350, tokens_cache_read: 2000 }, precios);
  assert.ok(conv > 0.004 && conv < 0.006, `costo por turno razonable, fue ${conv}`);
  assert.equal(costoEstimadoUsd({}, precios), 0);
});

test('recordTokens: cuenta también los tokens de caché (F13)', async () => {
  recordTokens({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 700, cache_read_input_tokens: 3000 });
  const s = await snapshot();
  assert.ok((s.counters['tokens_cache_write'] ?? 0) >= 700);
  assert.ok((s.counters['tokens_cache_read'] ?? 0) >= 3000);
});
