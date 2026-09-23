#!/usr/bin/env node
/** Verificación puntual: confirma que lesson.herramienta quedó escrito tras la carga del
 *  currículo. Solo lectura. node scripts/verificar-herramienta.mjs */
import pg from 'pg';
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL.'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query(`
  SELECT l.orden, l.titulo, l.herramienta FROM lesson l
    JOIN module m ON m.id = l.module_id JOIN course c ON c.id = m.course_id
   WHERE c.estado = 'activo' ORDER BY l.orden`);
for (const r of rows) {
  console.log(`${r.orden} | ${r.titulo} | ${r.herramienta ? JSON.stringify(r.herramienta) : 'NULL'}`);
}
await pool.end();
