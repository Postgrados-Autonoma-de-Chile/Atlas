// Ingesta de contenido al RAG (Fase 5). Requiere DATABASE_URL (migrado) y GEMINI_API_KEY.
//
// Modos:
//   npx tsx scripts/ingerir-contenido.ts descripciones [CODIGO]
//     → Indexa el título+descripción oficial de cada microcápsula del curso (corpus mínimo:
//       el RAG responde desde hoy, mientras llegan las transcripciones). CODIGO default: curso activo.
//
//   npx tsx scripts/ingerir-contenido.ts transcripcion <CODIGO> <ORDEN_LECCION> <archivo.txt|.md|.vtt>
//     → Carga la transcripción de una microcápsula: chunking (~500 tok, solape 15%) + embeddings +
//       reemplazo atómico de los chunks del item. Idempotente por hash (si el texto no cambió, omite).
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { initDb, getPool } from '../src/store/db';
import { chunkTexto } from '../src/rag/chunker';
import { embedTextos, vectorALiteral } from '../src/ai/embeddings';

const hash = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function cursoPorCodigo(codigo?: string) {
  const pool = getPool()!;
  const r = codigo
    ? await pool.query(`SELECT id, codigo, nombre FROM course WHERE codigo=$1`, [codigo])
    : await pool.query(`SELECT id, codigo, nombre FROM course WHERE estado='activo' ORDER BY created_at LIMIT 1`);
  if (!r.rows[0]) throw new Error(`Curso no encontrado (${codigo ?? 'activo'}). ¿Corriste las migraciones?`);
  return r.rows[0] as { id: string; codigo: string; nombre: string };
}

/** Reemplaza (tx) los chunks de un content_item: borra los antiguos e inserta los nuevos con embedding. */
async function reemplazarChunks(
  itemId: string, lessonId: string, courseId: string, fuente: string,
  chunks: { orden: number; texto: string }[],
) {
  const vectores = await embedTextos(chunks.map((c) => c.texto), 'documento');
  if (!vectores) throw new Error('Embeddings no disponibles (¿GEMINI_API_KEY?)');
  const client = await getPool()!.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM content_chunk WHERE content_item_id=$1`, [itemId]);
    for (let i = 0; i < chunks.length; i++) {
      const ref = chunks.length > 1 ? `${fuente} (parte ${i + 1})` : fuente;
      await client.query(
        `INSERT INTO content_chunk (content_item_id, lesson_id, course_id, orden, texto, fuente_ref, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector)`,
        [itemId, lessonId, courseId, chunks[i].orden, chunks[i].texto, ref, vectorALiteral(vectores[i])],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Busca (o crea) el content_item de un tipo para una lección. NO escribe texto_hash: el hash se
 *  marca recién cuando los chunks quedaron insertados (marcarIngerido) — si los embeddings fallan,
 *  el próximo run reintenta en vez de saltarse el contenido como "sin cambios" (revisión F9.1). */
async function upsertItem(lessonId: string, tipo: string, titulo: string, texto: string) {
  const pool = getPool()!;
  const existente = await pool.query(
    `SELECT id, texto_hash FROM content_item WHERE lesson_id=$1 AND tipo=$2 LIMIT 1`,
    [lessonId, tipo],
  );
  const h = hash(texto);
  if (existente.rows[0]) {
    const sinCambios = existente.rows[0].texto_hash === h;
    if (!sinCambios) {
      await pool.query(`UPDATE content_item SET titulo=$2, texto=$3 WHERE id=$1`, [existente.rows[0].id, titulo, texto]);
    }
    return { id: existente.rows[0].id as string, sinCambios, h };
  }
  const r = await pool.query(
    `INSERT INTO content_item (lesson_id, tipo, titulo, texto) VALUES ($1,$2,$3,$4) RETURNING id`,
    [lessonId, tipo, titulo, texto],
  );
  return { id: r.rows[0].id as string, sinCambios: false, h };
}

/** Marca la ingesta como completada (solo tras insertar los chunks con éxito). */
async function marcarIngerido(itemId: string, h: string) {
  await getPool()!.query(`UPDATE content_item SET texto_hash=$2 WHERE id=$1`, [itemId, h]);
}

async function modoDescripciones(codigo?: string) {
  const curso = await cursoPorCodigo(codigo);
  const lecciones = await getPool()!.query(
    `SELECT l.id, l.orden, l.titulo, l.descripcion FROM lesson l JOIN module m ON m.id=l.module_id
     WHERE m.course_id=$1 ORDER BY m.orden, l.orden`,
    [curso.id],
  );
  let indexadas = 0, omitidas = 0;
  for (const l of lecciones.rows) {
    const texto = `${l.titulo}\n\n${l.descripcion ?? ''}`.trim();
    const fuente = `Microcápsula ${l.orden}: ${l.titulo}`;
    const item = await upsertItem(l.id, 'material', 'Descripción oficial de la microcápsula', texto);
    if (item.sinCambios) { omitidas++; continue; }
    await reemplazarChunks(item.id, l.id, curso.id, fuente, chunkTexto(texto));
    await marcarIngerido(item.id, item.h);
    indexadas++;
    console.log(`✔ ${fuente}`);
  }
  console.log(`Listo: ${indexadas} microcápsulas indexadas, ${omitidas} sin cambios — curso ${curso.codigo}.`);
}

async function modoTranscripcion(codigo: string, ordenStr: string, archivo: string) {
  const orden = Number(ordenStr);
  if (!Number.isInteger(orden) || orden < 1) throw new Error('ORDEN_LECCION debe ser un entero ≥ 1');
  const curso = await cursoPorCodigo(codigo);
  const l = await getPool()!.query(
    `SELECT l.id, l.orden, l.titulo FROM lesson l JOIN module m ON m.id=l.module_id
     WHERE m.course_id=$1 AND l.orden=$2 LIMIT 1`,
    [curso.id, orden],
  );
  if (!l.rows[0]) throw new Error(`No existe la lección ${orden} en ${curso.codigo}`);
  const crudo = readFileSync(archivo, 'utf8');
  // VTT/SRT: quita timestamps y numeración para quedarnos con el texto hablado.
  const texto = crudo
    .replace(/^WEBVTT.*$/m, '')
    .replace(/^\d+$/gm, '')
    .replace(/\d{2}:\d{2}(:\d{2})?[.,]\d{3} --> .*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (texto.length < 50) throw new Error('El archivo quedó (casi) vacío tras limpiar; revisa el formato.');

  const fuente = `Microcápsula ${l.rows[0].orden}: ${l.rows[0].titulo}`;
  const item = await upsertItem(l.rows[0].id, 'transcripcion', `Transcripción — ${l.rows[0].titulo}`, texto);
  if (item.sinCambios) {
    console.log(`Sin cambios (mismo hash): ${fuente}`);
    return;
  }
  const chunks = chunkTexto(texto);
  await reemplazarChunks(item.id, l.rows[0].id, curso.id, fuente, chunks);
  await marcarIngerido(item.id, item.h);
  console.log(`✔ ${fuente}: ${chunks.length} chunks indexados (${texto.length} chars).`);
}

async function main() {
  const [modo, a, b, c] = process.argv.slice(2);
  await initDb();
  if (!getPool()) throw new Error('Sin DATABASE_URL o esquema sin migrar (npm run migrate).');
  if (modo === 'descripciones') return modoDescripciones(a);
  if (modo === 'transcripcion') {
    if (!a || !b || !c) throw new Error('Uso: transcripcion <CODIGO> <ORDEN_LECCION> <archivo>');
    return modoTranscripcion(a, b, c);
  }
  throw new Error('Uso: descripciones [CODIGO] | transcripcion <CODIGO> <ORDEN_LECCION> <archivo>');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
