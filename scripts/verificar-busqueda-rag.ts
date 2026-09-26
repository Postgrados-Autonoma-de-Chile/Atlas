// Ejercita buscarContenidoCurso() de verdad —la misma función que usa la tool del tutor—, no una
// reimplementación. Requiere DATABASE_URL y GEMINI_API_KEY. Solo lectura.
//   npx tsx scripts/verificar-busqueda-rag.ts "pregunta de estudiante"
import { initDb, getPool } from '../src/store/db';
import { buscarContenidoCurso } from '../src/rag/retrieval';

initDb();
const pregunta = process.argv[2] ?? '¿cómo verifico si una información es confiable?';
const pool = getPool()!;
const { rows } = await pool.query(`SELECT id, codigo FROM course WHERE estado='activo'`);
const curso = rows[0];
console.log('curso:', curso.codigo);
console.log('pregunta:', pregunta);
const r = await buscarContenidoCurso(curso.id, pregunta);
console.log('disponible:', r.disponible, '| encontrado:', r.encontrado, '| resultados:', r.resultados.length);
for (const res of r.resultados) {
  console.log(`  [${res.fuente}] similitud=${res.similitud} leccion=${res.leccionOrden}`);
  console.log(`    "${res.texto.slice(0, 200).replace(/\n/g, ' | ')}"`);
}
await pool.end();
