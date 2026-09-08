import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Caracterización en el panel: el agregado y el detalle paginado.
//
// A escala de programa esta es la tabla grande: 200.000 personas × 11 respuestas son 2,2 millones
// de filas. Las dos consultas tienen que seguir siendo baratas ahí, y por eso se resuelven
// distinto — el agregado se cachea, el detalle se pagina por KEYSET.
//
// Lo que estas pruebas cuidan sobre todo es que NUNCA aparezca un OFFSET: con OFFSET, la página
// 4.000 obliga a Postgres a leer y descartar 200.000 filas antes de devolver 50. El costo crece con
// el número de página, y el panel se vuelve el peor enemigo de la base justo cuando el programa
// está en su punto más grande.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let sqls: string[] = [];
let personas: any[] = [];
let respuestas: any[] = [];
const AGREGADO = [
  { orden: 1, codigo: 'edad', enunciado: '¿Cuál es su rango de edad?', op_orden: 1, texto: '18–24 años', n: 40 },
  { orden: 1, codigo: 'edad', enunciado: '¿Cuál es su rango de edad?', op_orden: 2, texto: '25–34 años', n: 60 },
  { orden: 2, codigo: 'genero', enunciado: '¿Con qué género se identifica?', op_orden: 1, texto: 'Mujer', n: 55 },
  { orden: 2, codigo: 'genero', enunciado: '¿Con qué género se identifica?', op_orden: 2, texto: 'Hombre', n: 45 },
];
const COLUMNAS = [
  { codigo: 'edad', enunciado: '¿Cuál es su rango de edad?' },
  { codigo: 'genero', enunciado: '¿Con qué género se identifica?' },
];

function responder(sql: string, params?: any[]) {
  sqls.push(sql);
  if (/FROM survey_question q/.test(sql) && /GROUP BY/.test(sql)) return { rows: AGREGADO };
  if (/SELECT codigo, enunciado FROM survey_question/.test(sql)) return { rows: COLUMNAS };
  if (/FROM person p/.test(sql)) {
    const limite = params?.[0] ?? 51;
    return { rows: personas.slice(0, limite) };
  }
  if (/FROM survey_answer a/.test(sql)) return { rows: respuestas };
  throw new Error('consulta no prevista: ' + sql.replace(/\s+/g, ' ').slice(0, 60));
}

mock.module('../src/store/db.ts', {
  namedExports: {
    dbEnabled: () => true, dbInsertAudit: async () => {},
    getPool: () => ({ query: async (sql: string, params?: any[]) => responder(sql, params) }),
  },
});

const { caracterizacionAgregada, caracterizacionPagina } = await import('../src/store/panel');
const { caracterizacionHtml, filasDetalleHtml } = await import('../src/obs/panelHtml');

const persona = (i: number, ts: string) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  nombre: `Persona${i}`, apellido: 'Prueba',
  completada: new Date(ts), wa_id: `+5690000${String(i).padStart(4, '0')}`,
});
const reset = () => { sqls = []; personas = []; respuestas = []; };

// ── Lo que no puede pasar nunca ─────────────────────────────────────────────

test('ninguna consulta usa OFFSET', async () => {
  reset();
  personas = [persona(1, '2026-09-08T12:00:00Z')];
  await caracterizacionAgregada();
  await caracterizacionPagina(null, 50);
  await caracterizacionPagina('2026-09-08T12:00:00.000Z|00000000-0000-4000-8000-000000000001', 50);
  for (const s of sqls) {
    assert.doesNotMatch(s, /\bOFFSET\b/i, 'un OFFSET hace que el costo crezca con el número de página');
  }
  assert.ok(sqls.some((s) => /caracterizacion_completada_en, p\.id\) </.test(s)), 'pagina por keyset');
});

test('el detalle solo pide las respuestas de las personas de la página', async () => {
  // Sin el ANY(...) acotado, mostrar una página leería los 2,2 millones de respuestas.
  reset();
  personas = Array.from({ length: 3 }, (_, i) => persona(i + 1, '2026-09-08T12:00:00Z'));
  await caracterizacionPagina(null, 50);
  const q = sqls.find((s) => /FROM survey_answer a/.test(s))!;
  assert.match(q, /person_id = ANY/);
  assert.doesNotMatch(q, /JOIN person\b/, 'no recorre el padrón');
});

test('el límite por página tiene tope, aunque lo pidan más grande', async () => {
  reset();
  personas = [persona(1, '2026-09-08T12:00:00Z')];
  await caracterizacionPagina(null, 100000);
  const q = sqls.find((s) => /FROM person p/.test(s));
  assert.ok(q, 'se consultó a las personas');
});

// ── Keyset ──────────────────────────────────────────────────────────────────

test('devuelve cursor solo cuando hay página siguiente', async () => {
  reset();
  personas = Array.from({ length: 51 }, (_, i) => persona(i + 1, '2026-09-08T12:00:00Z'));
  const p1 = await caracterizacionPagina(null, 50);
  assert.equal(p1!.filas.length, 50, 'se piden 51 para saber si hay más, pero se devuelven 50');
  assert.ok(p1!.siguiente, 'hay cursor');
  assert.match(p1!.siguiente!, /^\d{4}-\d{2}-\d{2}T.*\|[0-9a-f-]{36}$/);

  reset();
  personas = Array.from({ length: 12 }, (_, i) => persona(i + 1, '2026-09-08T12:00:00Z'));
  const p2 = await caracterizacionPagina(null, 50);
  assert.equal(p2!.siguiente, null, 'última página, sin cursor');
});

test('un cursor inválido se ignora en vez de romper la consulta', async () => {
  // El cursor viaja por la URL: es entrada no confiable.
  reset();
  personas = [persona(1, '2026-09-08T12:00:00Z')];
  for (const malo of ['', 'basura', "'; DROP TABLE person; --", 'no-es-fecha|00000000-0000-4000-8000-000000000001']) {
    const r = await caracterizacionPagina(malo, 10);
    assert.ok(r, `no debe fallar con: ${malo}`);
  }
  for (const s of sqls) assert.doesNotMatch(s, /DROP TABLE/i);
});

// ── Agregado ────────────────────────────────────────────────────────────────

test('el agregado reparte porcentajes por pregunta, no sobre el total', async () => {
  reset();
  const a = await caracterizacionAgregada();
  assert.equal(a!.length, 2, 'dos preguntas');
  assert.equal(a![0].respondieron, 100);
  assert.deepEqual(a![0].opciones.map((o) => o.pct), [40, 60]);
  assert.deepEqual(a![1].opciones.map((o) => o.pct), [55, 45]);
});

test('el agregado se cachea: la segunda llamada no vuelve a la base', async () => {
  // Es la consulta que recorre 2,2 millones de filas. Repetirla en cada carga de pantalla sería
  // convertir el panel en el problema.
  reset();
  await caracterizacionAgregada();
  const primeras = sqls.length;
  await caracterizacionAgregada();
  assert.equal(sqls.length, primeras, 'la segunda salió de caché');
});

// ── Render ──────────────────────────────────────────────────────────────────

test('el HTML muestra la distribución y el detalle', async () => {
  reset();
  personas = [persona(1, '2026-09-08T12:00:00Z')];
  respuestas = [
    { person_id: personas[0].id, codigo: 'edad', texto: '25–34 años' },
    { person_id: personas[0].id, codigo: 'genero', texto: 'Hombre' },
  ];
  const html = caracterizacionHtml((await caracterizacionAgregada())!, (await caracterizacionPagina(null, 50))!, false);
  assert.match(html, /100 personas completaron/);
  assert.match(html, /rango de edad/);
  assert.match(html, /25–34 años/);
  assert.match(html, /Persona1 Prueba/);
  assert.match(html, /\+5690000/);
});

test('una respuesta que falta se muestra como raya, no en blanco', async () => {
  reset();
  personas = [persona(1, '2026-09-08T12:00:00Z')];
  respuestas = [{ person_id: personas[0].id, codigo: 'edad', texto: '25–34 años' }];
  const html = filasDetalleHtml((await caracterizacionPagina(null, 50))!, true);
  assert.match(html, /<td>—<\/td>/, 'el género no respondido');
});

test('el fragmento de "cargar más" trae el cursor y ninguna cabecera', async () => {
  reset();
  personas = Array.from({ length: 51 }, (_, i) => persona(i + 1, '2026-09-08T12:00:00Z'));
  const frag = filasDetalleHtml((await caracterizacionPagina(null, 50))!, false);
  assert.doesNotMatch(frag, /<thead|<table/, 'solo filas: se agregan al tbody existente');
  assert.match(frag, /<!--CURSOR:.+-->/);
});
