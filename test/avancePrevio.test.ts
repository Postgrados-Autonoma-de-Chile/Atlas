import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Quien venía cursando una versión anterior del programa.
//
// Al actualizar el currículo, los cursos anteriores se archivan y estadoAcademico —que solo mira el
// curso activo— devuelve `inscrito: false`. Pasó de verdad: al cambiar al plan oficial, 13 personas
// quedaron colgando del curso archivado, 4 de ellas con microcápsulas completadas y una con
// certificado emitido. Sin este reconocimiento, ATLAS las saluda como estudiantes nuevas.
//
// El avance NO se traslada: las microcápsulas de una versión y otra no se corresponden, y darlas
// por equivalentes falsearía la evidencia. Se reconoce, y nada más.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

type Fila = { nombre: string; total: number; completadas: number; folio: string | null };
let previo: Fila | null = null;
let inscritoEnActivo = false;

const CURSO_ACTIVO = {
  id: 'c-nuevo', codigo: 'NIVEL-1-IA-PROBLEMAS',
  nombre: 'Nivel Inicial: Alfabetización ciudadana en Inteligencia Artificial',
  descripcion: null, duracion_min: 55,
};

const responder = (sql: string) => {
  if (/FROM course WHERE estado='activo'/.test(sql)) return { rows: [CURSO_ACTIVO], rowCount: 1 };
  // estadoAcademico: inscripción en el curso ACTIVO.
  if (/FROM enrollment e JOIN course c/.test(sql) && /c\.estado = 'activo'/.test(sql)) {
    return inscritoEnActivo
      ? { rows: [{ course_id: 'c-nuevo', codigo: CURSO_ACTIVO.codigo, nombre: CURSO_ACTIVO.nombre, duracion_min: 55, enrollment_id: 'e-nuevo', estado: 'activa', minutos_acumulados: 0, total: 8, completadas: 0 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  // avancePrevioArchivado: inscripción en un curso NO activo.
  if (/c\.estado <> 'activo'/.test(sql)) return { rows: previo ? [previo] : [], rowCount: previo ? 1 : 0 };
  // próxima lección (estadoAcademico, cuando está inscrito)
  if (/FROM lesson l JOIN module m/.test(sql)) {
    return { rows: [{ orden: 1, titulo: 'IA como apoyo para resolver problemas cotidianos', tipo: 'capsula', duracion_min: 6 }], rowCount: 1 };
  }
  throw new Error('consulta no prevista: ' + sql.replace(/\s+/g, ' ').slice(0, 70));
};

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => ({ query: async (sql: string) => responder(sql) }) },
});

const { avancePrevioArchivado, contextoAcademico, frasePrevio } = await import('../src/store/cursos');

test('con avance en la versión anterior, se recupera para poder reconocerlo', async () => {
  previo = { nombre: 'IA en la vida cotidiana', total: 9, completadas: 3, folio: null };
  const r = await avancePrevioArchivado('p1');
  assert.deepEqual(r, { curso: 'IA en la vida cotidiana', completadas: 3, total: 9, folio: null });
});

test('sin avance ni certificado NO se reconoce nada', async () => {
  // Ocho de las trece personas estaban inscritas sin haber completado ninguna microcápsula. Decirle
  // "ya habías empezado" a alguien que nunca empezó es ruido, y además es falso.
  previo = { nombre: 'IA en la vida cotidiana', total: 9, completadas: 0, folio: null };
  assert.equal(await avancePrevioArchivado('p1'), null);
});

test('quien se certificó en la versión anterior sí se reconoce, aunque tenga 0 pendientes', async () => {
  previo = { nombre: 'IA en la vida cotidiana', total: 9, completadas: 9, folio: 'ATLAS-2026-0002' };
  const r = await avancePrevioArchivado('p1');
  assert.equal(r!.folio, 'ATLAS-2026-0002');
  const f = frasePrevio(r!);
  assert.match(f, /COMPLETADO/);
  assert.match(f, /ATLAS-2026-0002/);
  assert.match(f, /sigue siendo válido/, 'su certificado no se invalidó y hay que decirlo');
});

test('sin inscripción anterior no hay nada que reconocer', async () => {
  previo = null;
  assert.equal(await avancePrevioArchivado('p1'), null);
});

test('la rehidratación del tutor incluye el reconocimiento y prohíbe prometer el traslado', async () => {
  previo = { nombre: 'IA en la vida cotidiana', total: 9, completadas: 3, folio: null };
  inscritoEnActivo = false;
  const ctx = await contextoAcademico('p1', 'Rodrigo');
  assert.match(ctx, /NO está inscrito/, 'sigue siendo alguien a quien hay que inscribir');
  assert.match(ctx, /3 de 9 microcápsulas/);
  assert.match(ctx, /versión anterior/);
  assert.match(ctx, /NO se traslada/);
  assert.match(ctx, /UNA frase/, 'reconocer, no dar un discurso');
  assert.doesNotMatch(ctx, /disculp[ae]s\b(?!.*de más)/i);
  assert.match(ctx, /NO prometas recuperar/, 'la trampa evidente es ofrecerle saltarse microcápsulas');
});

test('sin avance previo, la rehidratación queda como siempre', async () => {
  previo = null;
  inscritoEnActivo = false;
  const ctx = await contextoAcademico('p1', 'Rodrigo');
  assert.match(ctx, /Aún NO está inscrito/);
  assert.doesNotMatch(ctx, /versión anterior/, 'no se menciona algo que no ocurrió');
});

test('a quien ya está inscrito en el curso nuevo no se le habla del anterior', async () => {
  // Una vez dentro del curso oficial, repetir el aviso en cada rehidratación sería insistir con
  // algo que ya se dijo y que no puede cambiar.
  previo = { nombre: 'IA en la vida cotidiana', total: 9, completadas: 3, folio: null };
  inscritoEnActivo = true;
  const ctx = await contextoAcademico('p1', 'Rodrigo');
  assert.match(ctx, /Alfabetización ciudadana/);
  assert.doesNotMatch(ctx, /versión anterior/);
});
