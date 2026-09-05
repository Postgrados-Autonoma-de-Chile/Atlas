import { test } from 'node:test';
import assert from 'node:assert/strict';

// Chunker del RAG (Fase 5): puro y determinista.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { chunkTexto } = await import('../src/rag/chunker');
const { normalizarL2, vectorALiteral, construirBatchRequest } = await import('../src/ai/embeddings');

test('texto corto: un solo chunk, limpio', () => {
  const r = chunkTexto('  Hola.\r\nEsto es una transcripción corta.  ');
  assert.equal(r.length, 1);
  assert.equal(r[0].orden, 0);
  assert.ok(!r[0].texto.includes('\r'));
});

test('texto vacío: sin chunks', () => {
  assert.deepEqual(chunkTexto(''), []);
  assert.deepEqual(chunkTexto('   \n  '), []);
});

test('texto largo: respeta el tamaño máximo y genera solape', () => {
  const oracion = 'La inteligencia artificial aprende de datos y genera respuestas útiles para las personas. ';
  const texto = oracion.repeat(120); // ~11.000 chars
  const chunks = chunkTexto(texto, { maxChars: 2000, solape: 0.15 });
  assert.ok(chunks.length >= 6, `esperaba ≥6 chunks, hubo ${chunks.length}`);
  for (const c of chunks) assert.ok(c.texto.length <= 2000, `chunk de ${c.texto.length} chars supera el máximo`);
  // Órdenes consecutivos desde 0.
  assert.deepEqual(chunks.map((c) => c.orden), chunks.map((_, i) => i));
  // Solape: el inicio del chunk 2 debe repetir texto del final del chunk 1.
  const finAnterior = chunks[0].texto.slice(-120);
  assert.ok(
    chunks[1].texto.startsWith(finAnterior.slice(finAnterior.indexOf(' ') + 1, finAnterior.indexOf(' ') + 40)) ||
      chunks[1].texto.includes(finAnterior.slice(-60)),
    'el chunk 2 comparte contenido con el final del chunk 1 (solape)',
  );
});

test('prefiere cortar en límite de párrafo', () => {
  const p1 = 'Párrafo uno. '.repeat(60).trim(); // ~780 chars
  const p2 = 'Párrafo dos distinto. '.repeat(60).trim();
  const chunks = chunkTexto(`${p1}\n\n${p2}`, { maxChars: 1000, solape: 0.1 });
  assert.ok(chunks[0].texto.endsWith('Párrafo uno.'), 'el primer chunk termina donde termina el párrafo');
});

test('normalizarL2: vector unitario y estable', () => {
  const v = normalizarL2([3, 4]);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  assert.deepEqual(normalizarL2([0, 0]), [0, 0]); // no divide por cero
});

test('vectorALiteral y construirBatchRequest: formatos correctos', () => {
  assert.equal(vectorALiteral([0.1, -0.2, 1]), '[0.1,-0.2,1]');
  const req = construirBatchRequest(['hola', 'chao'], 'documento');
  assert.equal(req.requests.length, 2);
  assert.equal(req.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(req.requests[0].content.parts[0].text, 'hola');
  assert.equal(req.requests[0].outputDimensionality, 768);
  assert.match(req.requests[0].model, /^models\/gemini-embedding/);
});
