#!/usr/bin/env node
/** Verificación puntual del RAG: qué hay cargado hoy en content_item/content_chunk para el curso
 *  vigente. Solo lectura. node scripts/verificar-rag.mjs */
import pg from 'pg';
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL.'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows: curso } = await pool.query(`SELECT id, codigo, nombre FROM course WHERE estado='activo'`);
console.log('curso vigente:', curso[0]?.codigo, curso[0]?.id);
const { rows: items } = await pool.query(
  `SELECT ci.id, ci.lesson_id, ci.tipo, ci.titulo, ci.url IS NOT NULL AS con_url,
          length(coalesce(ci.texto_hash,'')) AS hash_len,
          (SELECT count(*) FROM content_chunk cc WHERE cc.content_item_id = ci.id) AS chunks
     FROM content_item ci JOIN lesson l ON l.id = ci.lesson_id JOIN module m ON m.id = l.module_id
    WHERE m.course_id = $1 ORDER BY l.orden, ci.tipo`,
  [curso[0]?.id],
);
console.log(`content_item para este curso: ${items.length}`);
for (const it of items) {
  console.log(`  lesson=${it.lesson_id.slice(0, 8)} tipo=${it.tipo} titulo="${it.titulo ?? ''}" url=${it.con_url} hash=${it.hash_len > 0} chunks=${it.chunks}`);
}
const { rows: totalChunks } = await pool.query(
  `SELECT count(*)::int AS n FROM content_chunk cc WHERE cc.course_id = $1`, [curso[0]?.id],
);
console.log('total content_chunk para este curso:', totalChunks[0]?.n);

// Muestra del texto real de un chunk, para saber si es contenido rico o solo la descripción corta.
const { rows: muestra } = await pool.query(
  `SELECT fuente_ref, length(texto) AS len, left(texto, 300) AS inicio
     FROM content_chunk WHERE course_id = $1 ORDER BY lesson_id, orden LIMIT 3`,
  [curso[0]?.id],
);
console.log('\nmuestra de 3 chunks:');
for (const m of muestra) {
  console.log(`  [${m.fuente_ref}] len=${m.len}`);
  console.log(`    "${m.inicio.replace(/\n/g, ' | ')}"`);
}
await pool.end();
