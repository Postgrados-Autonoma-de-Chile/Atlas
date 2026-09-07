#!/usr/bin/env node
/**
 * Estado de la cohorte, en agregado. Solo lectura.
 *
 *   node scripts/reporte-cohorte.mjs
 *
 * Sirve para decidir con datos antes de cambiar el curso activo: cuánta gente hay inscrita en cada
 * curso y cuánto avance tiene. Cambiar el currículo archiva los cursos anteriores, y quien esté a
 * medio camino en uno archivado queda como no inscrito — hay que saber a cuántos afecta.
 *
 * NO imprime datos personales: ni teléfono, ni nombre, ni correo. Solo conteos y fechas. El avance
 * por persona va anonimizado con los primeros 8 caracteres del id, que basta para contar casos.
 */
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const tabla = (filas) => {
  if (!filas.length) return '  (sin datos)';
  const cols = Object.keys(filas[0]);
  const ancho = cols.map((c) => Math.max(c.length, ...filas.map((f) => String(f[c] ?? '').length)));
  const linea = (vals) => '  ' + vals.map((v, i) => String(v ?? '').padEnd(ancho[i])).join('  ');
  return [linea(cols), linea(ancho.map((a) => '-'.repeat(a))), ...filas.map((f) => linea(cols.map((c) => f[c])))].join('\n');
};

try {
  const cursos = await pool.query(
    `SELECT c.codigo, c.estado, c.nombre,
            (SELECT count(*)::int FROM lesson l JOIN module m ON m.id=l.module_id WHERE m.course_id=c.id) AS lecciones,
            (SELECT count(*)::int FROM enrollment e WHERE e.course_id=c.id) AS inscritos
       FROM course c ORDER BY c.estado, c.created_at`,
  );
  console.log('\nCURSOS\n' + tabla(cursos.rows));

  const avance = await pool.query(
    `SELECT c.codigo AS curso, e.estado AS inscripcion,
            count(*) FILTER (WHERE lp.estado='completada')::int AS completadas,
            count(*)::int AS personas
       FROM enrollment e
       JOIN course c ON c.id = e.course_id
       LEFT JOIN lesson_progress lp ON lp.enrollment_id = e.id
      GROUP BY c.codigo, e.estado, e.id
      ORDER BY c.codigo, completadas DESC`,
  );
  // Agrupa por cantidad de microcápsulas completadas: cuántas personas están en cada punto.
  const porAvance = new Map();
  for (const r of avance.rows) {
    const k = `${r.curso}|${r.inscripcion}|${r.completadas}`;
    porAvance.set(k, (porAvance.get(k) ?? 0) + 1);
  }
  console.log('\nAVANCE (personas por microcápsulas completadas)\n' + tabla(
    [...porAvance.entries()].map(([k, personas]) => {
      const [curso, inscripcion, completadas] = k.split('|');
      return { curso, inscripcion, completadas, personas };
    }),
  ));

  const cert = await pool.query(
    `SELECT count(*)::int AS emitidos, min(folio) AS primero, max(folio) AS ultimo
       FROM certificate WHERE folio IS NOT NULL`,
  );
  console.log('\nCERTIFICADOS\n' + tabla(cert.rows));

  const act = await pool.query(
    `SELECT to_char(max(e.iniciado_en), 'YYYY-MM-DD HH24:MI') AS ultima_inscripcion,
            (SELECT count(*)::int FROM person) AS personas_registradas
       FROM enrollment e`,
  );
  console.log('\nACTIVIDAD\n' + tabla(act.rows));

  const mig = await pool.query(`SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 3`);
  console.log('\nÚLTIMAS MIGRACIONES APLICADAS\n' + tabla(mig.rows) + '\n');
} catch (e) {
  console.error('falló el reporte:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
