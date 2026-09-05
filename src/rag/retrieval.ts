import { getPool } from '../store/db';
import { config } from '../config';
import { log } from '../log';
import { embedTextos, vectorALiteral } from '../ai/embeddings';

// Retrieval del contenido del curso (Fase 5): búsqueda vectorial (pgvector, coseno) con UMBRAL de
// confianza + fallback léxico (tsquery español) para términos exactos que el vector pudiera perder.
// Regla del requisito §8: si nada supera el umbral, se responde encontrado:false — el tutor debe
// decir honestamente que el material no cubre la pregunta, nunca inventar.

export type ResultadoRag = {
  /** false = RAG no operativo (sin BD o sin API de embeddings): distinto de "no encontrado". */
  disponible: boolean;
  encontrado: boolean;
  resultados: { texto: string; fuente: string; leccionOrden: number | null; similitud: number }[];
};

const NO_DISPONIBLE: ResultadoRag = { disponible: false, encontrado: false, resultados: [] };

export async function buscarContenidoCurso(courseId: string, consulta: string): Promise<ResultadoRag> {
  const pool = getPool();
  if (!pool) return NO_DISPONIBLE;

  const embeddings = await embedTextos([consulta], 'consulta');
  if (!embeddings) return NO_DISPONIBLE;
  const vector = vectorALiteral(embeddings[0]);

  try {
    const r = await pool.query(
      `SELECT cc.texto, cc.fuente_ref, l.orden AS leccion_orden,
              1 - (cc.embedding <=> $1::vector) AS similitud
       FROM content_chunk cc
       LEFT JOIN lesson l ON l.id = cc.lesson_id
       WHERE cc.course_id = $2
       ORDER BY cc.embedding <=> $1::vector
       LIMIT $3`,
      [vector, courseId, config.ragTopK],
    );
    const relevantes = r.rows.filter((row: any) => Number(row.similitud) >= config.ragMinScore);
    if (relevantes.length) {
      return {
        disponible: true,
        encontrado: true,
        resultados: relevantes.map((row: any) => ({
          texto: row.texto,
          fuente: row.fuente_ref,
          leccionOrden: row.leccion_orden,
          similitud: Math.round(Number(row.similitud) * 1000) / 1000,
        })),
      };
    }

    // Fallback léxico: cubre términos exactos (nombres, siglas) con baja similitud vectorial.
    const lex = await pool.query(
      `SELECT cc.texto, cc.fuente_ref, l.orden AS leccion_orden
       FROM content_chunk cc
       LEFT JOIN lesson l ON l.id = cc.lesson_id
       WHERE cc.course_id = $1
         AND to_tsvector('spanish', cc.texto) @@ plainto_tsquery('spanish', $2)
       LIMIT $3`,
      [courseId, consulta, config.ragTopK],
    );
    if (lex.rows.length) {
      return {
        disponible: true,
        encontrado: true,
        resultados: lex.rows.map((row: any) => ({
          texto: row.texto,
          fuente: row.fuente_ref,
          leccionOrden: row.leccion_orden,
          similitud: 0,
        })),
      };
    }
    return { disponible: true, encontrado: false, resultados: [] };
  } catch (e) {
    log.warn('rag: buscarContenidoCurso falló', { err: String(e) });
    return NO_DISPONIBLE;
  }
}
