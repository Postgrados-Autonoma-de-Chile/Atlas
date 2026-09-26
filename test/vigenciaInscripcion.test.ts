import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Vigencia del cupo: la inscripción dura 30 días y después vence.
//
// POR QUÉ EXISTE: hasta ahora una inscripción no vencía nunca, así que "tienes microcápsulas
// pendientes" no tenía ninguna consecuencia detrás. Con un plazo real el mensaje se vuelve cierto,
// el seguimiento se puede cerrar, y el recordatorio pasa a ser el aviso de una obligación con
// fecha — que es lo único que Meta admite como plantilla utility. Inventar la fecha habría sido
// engañar al estudiante y a Meta; tenerla de verdad, no.
//
// DECISIÓN: vence pero se puede reactivar, conservando el avance. Cerrar la puerta costaría
// certificados —uno adicional sale CLP 114 al margen— sin ganar nada: el cupo no es escaso por
// ninguna limitación técnica.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let sqls: { sql: string; params?: any[] }[] = [];
let filaEnrollment: any = null;
let filasUpdate: any[] = [];

function responder(sql: string, params?: any[]) {
  sqls.push({ sql, params });
  if (/FROM course WHERE estado='activo'/.test(sql)) {
    return { rows: [{ id: 'c1', codigo: 'NIVEL-1', nombre: 'Nivel Inicial', descripcion: null, duracion_min: 55 }] };
  }
  if (/INSERT INTO enrollment/.test(sql)) return { rows: [], rowCount: 1 };
  if (/UPDATE enrollment SET estado='vencida'/.test(sql)) return { rows: filasUpdate, rowCount: filasUpdate.length };
  if (/UPDATE enrollment e SET estado='activa'/.test(sql)) return { rows: filasUpdate, rowCount: filasUpdate.length };
  if (/FROM enrollment e JOIN course c/.test(sql)) return { rows: filaEnrollment ? [filaEnrollment] : [] };
  if (/FROM lesson l JOIN module m/.test(sql)) return { rows: [] };
  return { rows: [], rowCount: 0 };
}

mock.module('../src/store/db.ts', {
  namedExports: {
    dbEnabled: () => true, dbInsertAudit: async () => {},
    getPool: () => ({ query: async (sql: string, p?: any[]) => responder(sql, p) }),
  },
});

const { inscribir, estadoAcademico, expirarInscripciones, reactivarInscripcion } =
  await import('../src/store/cursos');

const reset = () => { sqls = []; filaEnrollment = null; filasUpdate = []; };
const sqlCon = (re: RegExp) => sqls.find((s) => re.test(s.sql));

test('inscribirse fija el plazo del cupo', async () => {
  reset();
  await inscribir('p1');
  const q = sqlCon(/INSERT INTO enrollment/)!;
  assert.match(q.sql, /vence_en/);
  assert.match(q.sql, /now\(\) \+ \(\$3 \|\| ' days'\)::interval/);
  assert.equal(q.params?.[2], '30', 'los 30 días vienen de configuración, no escritos a mano');
});

test('reinscribirse NO renueva el plazo de un cupo que sigue activo', async () => {
  // Si escribir "quiero inscribirme" renovara la vigencia, el plazo no existiría: bastaría
  // repetirlo para no vencer nunca.
  reset();
  await inscribir('p1');
  const q = sqlCon(/INSERT INTO enrollment/)!;
  assert.match(q.sql, /CASE WHEN enrollment\.estado = 'vencida'/);
  assert.match(q.sql, /ELSE enrollment\.vence_en END/, 'una activa conserva su fecha');
});

test('reinscribirse SÍ reactiva un cupo vencido', async () => {
  reset();
  await inscribir('p1');
  const q = sqlCon(/INSERT INTO enrollment/)!;
  assert.match(q.sql, /SET estado = CASE WHEN enrollment\.estado = 'vencida' THEN 'activa'/);
});

test('el barrido solo toca las activas con plazo cumplido', async () => {
  reset();
  filasUpdate = [{ id: 'e1' }, { id: 'e2' }];
  const n = await expirarInscripciones();
  assert.equal(n, 2);
  const q = sqlCon(/UPDATE enrollment SET estado='vencida'/)!;
  assert.match(q.sql, /estado='activa'/, 'no reabre completadas ni abandonadas');
  assert.match(q.sql, /vence_en IS NOT NULL/, 'las inscripciones sin plazo no vencen');
  assert.match(q.sql, /vence_en < now\(\)/);
});

test('el barrido es idempotente: correrlo dos veces no cambia nada', async () => {
  reset();
  filasUpdate = [];
  assert.equal(await expirarInscripciones(), 0);
});

test('vencer NO borra el avance', async () => {
  // La decisión fue conservar lo hecho: quien vuelve sigue donde quedó.
  reset();
  filasUpdate = [{ id: 'e1' }];
  await expirarInscripciones();
  const q = sqlCon(/UPDATE enrollment SET estado='vencida'/)!;
  assert.doesNotMatch(q.sql, /lesson_progress/, 'no toca el progreso');
  assert.doesNotMatch(q.sql, /DELETE/i);
});

test('reactivar devuelve un plazo nuevo y solo aplica a vencidas', async () => {
  reset();
  filasUpdate = [{ vence_en: new Date('2026-10-11T12:00:00Z') }];
  const r = await reactivarInscripcion('p1');
  assert.ok(r?.venceEn, 'devuelve la fecha nueva para poder decírsela');
  const q = sqlCon(/UPDATE enrollment e SET estado='activa'/)!;
  assert.match(q.sql, /e\.estado='vencida'/, 'no reabre una abandonada ni una completada');
  assert.match(q.sql, /c\.estado='activo'/, 'ni un curso archivado');
});

test('reactivar a quien no tiene cupo vencido devuelve null', async () => {
  reset();
  filasUpdate = [];
  assert.equal(await reactivarInscripcion('p1'), null);
});

test('el estado académico expone la fecha de vencimiento', async () => {
  // Es el dato que el tutor necesita para avisar, y el que vuelve cierto el recordatorio.
  reset();
  filaEnrollment = {
    course_id: 'c1', codigo: 'NIVEL-1', nombre: 'Nivel Inicial', duracion_min: 55,
    enrollment_id: 'e1', estado: 'activa', minutos_acumulados: 12,
    vence_en: new Date('2026-10-11T12:00:00Z'), total: 8, completadas: 2,
  };
  const e = await estadoAcademico('p1');
  assert.equal(e!.enrollment!.estado, 'activa');
  assert.deepEqual(e!.enrollment!.venceEn, new Date('2026-10-11T12:00:00Z'));
});

test('una inscripción vencida se reporta como tal, no como activa', async () => {
  reset();
  filaEnrollment = {
    course_id: 'c1', codigo: 'NIVEL-1', nombre: 'Nivel Inicial', duracion_min: 55,
    enrollment_id: 'e1', estado: 'vencida', minutos_acumulados: 12,
    vence_en: new Date('2026-09-01T12:00:00Z'), total: 8, completadas: 2,
  };
  const e = await estadoAcademico('p1');
  assert.equal(e!.enrollment!.estado, 'vencida');
  assert.equal(e!.completadas, 2, 'y su avance sigue ahí');
});
