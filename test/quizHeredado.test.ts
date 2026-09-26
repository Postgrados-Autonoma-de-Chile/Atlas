import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Quizzes cargados ANTES de la alineación curricular: sus columnas nuevas vienen en NULL.
//
// En producción hay una cohorte en curso sobre el curso anterior. Cuando el código nuevo se
// despliegue, sus quizzes seguirán teniendo tipo_interaccion, consigna, retroalimentacion y
// minimo_requerido en NULL hasta que se cargue el currículo — y el valor por omisión del mínimo
// decide si esos quizzes se responden completos o se cierran después de la primera pregunta.
//
// Sin mínimo declarado se responden TODOS los ítems: "al menos N" solo lo piden las cápsulas 6 y 8
// del plan, que sí traen el dato.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

/** Fila del quiz heredado: título y nada más. */
let filaQuiz: Record<string, unknown> = {
  total: 3, titulo: 'Mini-quiz — Microcápsula 1',
  tipo_interaccion: null, consigna: null, retroalimentacion: null, minimo_requerido: null,
};

const responder = (sql: string) => {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
  if (/FROM quiz z LEFT JOIN question/i.test(sql)) return { rows: [filaQuiz], rowCount: 1 };
  if (/MAX\(intento_n\)/i.test(sql)) return { rows: [{ n: 1 }], rowCount: 1 };
  if (/INSERT INTO quiz_attempt/i.test(sql)) return { rows: [{ id: 'a1' }], rowCount: 1 };
  if (/FROM question WHERE quiz_id/i.test(sql)) {
    return { rows: [{ id: 'q1', orden: 1, tipo: 'seleccion_multiple', enunciado: '¿Qué es la IA?', explicacion: 'La Microcápsula 1 lo explica.', sin_respuesta_correcta: null, item_texto: null }], rowCount: 1 };
  }
  if (/FROM question_option/i.test(sql)) {
    return { rows: [{ id: 'o1', orden: 1, texto: 'A', es_correcta: true }, { id: 'o2', orden: 2, texto: 'B', es_correcta: false }], rowCount: 2 };
  }
  throw new Error('consulta no prevista: ' + sql.slice(0, 60));
};

const pool = {
  query: async (sql: string) => responder(sql),
  connect: async () => ({ query: async (sql: string) => responder(sql), release: () => {} }),
};

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => pool },
});

const { iniciarAttempt } = await import('../src/store/evaluaciones');

test('un quiz heredado sin mínimo declarado exige TODOS sus ítems', async () => {
  // Con el valor por omisión en 1, un quiz de 3 preguntas se cerraba tras la primera: la cohorte
  // que hoy está cursando habría perdido dos tercios de su práctica sin que nadie lo notara.
  filaQuiz = { total: 3, titulo: 'Mini-quiz — Microcápsula 1', tipo_interaccion: null, consigna: null, retroalimentacion: null, minimo_requerido: null };
  const r = await iniciarAttempt('e1', 'z1');
  assert.ok(r, 'el intento se crea');
  assert.equal(r.total, 3);
  assert.equal(r.interaccion.minimoRequerido, 3, 'sin mínimo declarado, se responden los tres');
  assert.equal(r.interaccion.tipo, 'seleccion_unica', 'el tipo por omisión es el más simple');
  assert.equal(r.interaccion.consigna, null, 'no se inventa una consigna que el material no tiene');
});

test('un mínimo declarado se respeta (cápsula 6: al menos dos de seis)', async () => {
  filaQuiz = { total: 6, titulo: 'Lo intento', tipo_interaccion: 'seleccion_multiple', consigna: 'Selecciona al menos dos situaciones.', retroalimentacion: 'No necesitas revisar todos los casos.', minimo_requerido: 2 };
  const r = await iniciarAttempt('e1', 'z6');
  assert.equal(r!.interaccion.minimoRequerido, 2);
  assert.equal(r!.interaccion.tipo, 'seleccion_multiple');
});

test('un mínimo mayor que los ítems se recorta: si no, la actividad nunca cerraría', async () => {
  filaQuiz = { total: 2, titulo: 'Lo intento', tipo_interaccion: 'clasificacion', consigna: 'Clasifica.', retroalimentacion: 'Criterio.', minimo_requerido: 6 };
  const r = await iniciarAttempt('e1', 'z7');
  assert.equal(r!.interaccion.minimoRequerido, 2);
});

test('un quiz sin preguntas no crea intento', async () => {
  filaQuiz = { total: 0, titulo: 'Vacío', tipo_interaccion: null, consigna: null, retroalimentacion: null, minimo_requerido: null };
  assert.equal(await iniciarAttempt('e1', 'z0'), null);
});
