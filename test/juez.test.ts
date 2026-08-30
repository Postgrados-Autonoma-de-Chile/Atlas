import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Harness pedagógico (Fase 6): golden set válido, prompt del juez por tipo, veredicto vía
// structured output (cliente mockeado) y agregación del resumen con umbrales.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: '{}' }], usage: {} });
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => impl(args) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { cargarGoldenSet, construirPromptJuez, juzgarRespuesta, resumenEvaluacion, ESQUEMA_VEREDICTO } =
  await import('../src/eval/juez');
import type { ItemGolden, Veredicto } from '../src/eval/juez';

test('golden set del repo: carga y valida (ids únicos, tipos, fuenteEsperada en contenido)', () => {
  const items = cargarGoldenSet('eval/golden-set.json');
  assert.ok(items.length >= 14, `esperaba ≥14 casos, hay ${items.length}`);
  assert.ok(items.some((i) => i.tipo === 'contenido'));
  assert.ok(items.some((i) => i.tipo === 'fuera_de_material'));
  assert.ok(items.some((i) => i.tipo === 'cuidado'));
  for (const i of items.filter((x) => x.tipo === 'contenido')) assert.ok(i.fuenteEsperada, `${i.id} sin fuenteEsperada`);
});

test('construirPromptJuez: instrucciones específicas por tipo', () => {
  const base = { id: 'x', pregunta: '¿qué es la IA?', criterios: ['c1'] };
  const pc = construirPromptJuez({ ...base, tipo: 'contenido', fuenteEsperada: 'Microcápsula 1' } as ItemGolden, 'resp');
  assert.match(pc, /Microcápsula 1/);
  assert.match(pc, /CONTENIDO/);
  const pf = construirPromptJuez({ ...base, tipo: 'fuera_de_material' } as ItemGolden, 'resp');
  assert.match(pf, /FUERA del material/);
  const pq = construirPromptJuez({ ...base, tipo: 'cuidado' } as ItemGolden, 'resp');
  assert.match(pq, /CUIDADO/);
});

test('juzgarRespuesta: usa structured output (json_schema) y parsea el veredicto', async () => {
  let visto: any = null;
  impl = async (args: any) => {
    visto = args;
    return {
      content: [{ type: 'text', text: JSON.stringify({ aprobado: true, fidelidad: 5, claridad: 4, tono: 5, citaFuente: true, honestidad: true, comentario: 'ok' }) }],
      usage: {},
    };
  };
  const v = await juzgarRespuesta({ id: 'x', tipo: 'contenido', pregunta: 'p', fuenteEsperada: 'Microcápsula 1', criterios: ['c'] }, 'respuesta');
  assert.equal(v?.aprobado, true);
  assert.equal(v?.fidelidad, 5);
  assert.equal(visto.model, 'claude-test-haiku', 'usa el modelo económico');
  assert.deepEqual(visto.output_config.format.schema, ESQUEMA_VEREDICTO, 'exige el esquema del veredicto');
});

test('juzgarRespuesta: si el juez falla devuelve null (no revienta el harness)', async () => {
  impl = async () => { throw new Error('boom'); };
  const v = await juzgarRespuesta({ id: 'x', tipo: 'cuidado', pregunta: 'p', criterios: ['c'] }, 'r');
  assert.equal(v, null);
});

test('resumenEvaluacion: agrega tasas por tipo y lista reprobados', () => {
  const items: ItemGolden[] = [
    { id: 'a', tipo: 'contenido', pregunta: 'p', fuenteEsperada: 'M1', criterios: ['c'] },
    { id: 'b', tipo: 'contenido', pregunta: 'p', fuenteEsperada: 'M2', criterios: ['c'] },
    { id: 'c', tipo: 'fuera_de_material', pregunta: 'p', criterios: ['c'] },
    { id: 'd', tipo: 'cuidado', pregunta: 'p', criterios: ['c'] },
  ];
  const v = (aprobado: boolean, citaFuente: boolean, honestidad: boolean): Veredicto =>
    ({ aprobado, fidelidad: 4, claridad: 4, tono: 5, citaFuente, honestidad, comentario: aprobado ? 'ok' : 'faltó cita' });
  const r = resumenEvaluacion(items, [v(true, true, true), v(false, false, true), v(true, true, true), null]);
  assert.equal(r.total, 4);
  assert.equal(r.juzgados, 3, 'el null no cuenta como juzgado');
  assert.equal(r.aprobados, 2);
  assert.equal(r.citaFuenteContenido, 0.5, 'solo la mitad de los de contenido citó fuente');
  assert.equal(r.honestidadFuera, 1);
  assert.deepEqual(r.reprobados, [{ id: 'b', comentario: 'faltó cita' }]);
});
