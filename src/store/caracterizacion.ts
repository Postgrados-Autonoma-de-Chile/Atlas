import { getPool } from './db';
import { log } from '../log';

// Cuestionario de caracterización del plan curricular oficial (11 preguntas en tres secciones:
// antecedentes sociodemográficos, empleabilidad y trayectoria, necesidades e intereses).
//
// FUENTE: "Cuestionario de Caracterización (Ajustado).docx". El catálogo vive en la base
// (survey_question / survey_option) y lo carga scripts/cargar-curriculo.mjs: ajustar el
// cuestionario no debe exigir tocar código.
//
// El plan lo define como caracterización inicial para orientar la oferta formativa. NO establece
// que las respuestas modifiquen la ruta de aprendizaje, así que no se implementa ninguna
// ramificación: el currículo define el camino y es el mismo para todos. Las respuestas se guardan
// estructuradas para el reporte y para el perfil del estudiante.

export type PreguntaCaracterizacion = {
  id: string;
  codigo: string;
  orden: number;
  seccion: string | null;
  enunciado: string;
  opciones: { id: string; orden: number; texto: string }[];
};

/** Total de preguntas activas del cuestionario. */
export async function totalPreguntas(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const r = await pool.query(`SELECT count(*)::int AS n FROM survey_question WHERE estado='activo'`);
    return r.rows[0]?.n ?? 0;
  } catch (e) {
    log.warn('caracterizacion: totalPreguntas falló', { err: String(e) });
    return 0;
  }
}

/**
 * Siguiente pregunta sin responder, en el orden del cuestionario. null cuando ya respondió todas.
 *
 * Se resuelve contra la base y no contra un contador en memoria: si la persona abandona a mitad
 * del cuestionario y vuelve tres días después, retoma exactamente donde quedó.
 */
export async function siguientePregunta(personId: string): Promise<PreguntaCaracterizacion | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT q.id, q.codigo, q.orden, q.seccion, q.enunciado
         FROM survey_question q
        WHERE q.estado='activo'
          AND NOT EXISTS (SELECT 1 FROM survey_answer a WHERE a.question_id=q.id AND a.person_id=$1)
        ORDER BY q.orden LIMIT 1`,
      [personId],
    );
    const q = r.rows[0];
    if (!q) return null;
    const o = await pool.query(
      `SELECT id, orden, texto FROM survey_option WHERE question_id=$1 ORDER BY orden`,
      [q.id],
    );
    return { ...q, opciones: o.rows };
  } catch (e) {
    log.warn('caracterizacion: siguientePregunta falló', { err: String(e) });
    return null;
  }
}

/** Cuántas respondió, para poder mostrar "pregunta 4 de 11". */
export async function respondidas(personId: string): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM survey_answer a
         JOIN survey_question q ON q.id=a.question_id AND q.estado='activo'
        WHERE a.person_id=$1`,
      [personId],
    );
    return r.rows[0]?.n ?? 0;
  } catch (e) {
    log.warn('caracterizacion: respondidas falló', { err: String(e) });
    return 0;
  }
}

/** Guarda una respuesta. Idempotente: repetir la misma pregunta actualiza, no duplica. */
export async function guardarRespuesta(personId: string, questionId: string, optionId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO survey_answer (person_id, question_id, option_id) VALUES ($1,$2,$3)
       ON CONFLICT ON CONSTRAINT survey_answer_unico
       DO UPDATE SET option_id=EXCLUDED.option_id, respondido_en=now()`,
      [personId, questionId, optionId],
    );
    return true;
  } catch (e) {
    log.error('caracterizacion: guardarRespuesta falló', { err: String(e) });
    return false;
  }
}

/**
 * Marca la caracterización como completada si ya respondió todas las preguntas activas.
 * Devuelve true si quedó completa (recién ahora o antes).
 *
 * La marca se guarda en person para no tener que contar respuestas en cada turno: el bot consulta
 * este estado antes de permitir iniciar la ruta.
 */
export async function cerrarSiCompleta(personId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(
      `UPDATE person p SET caracterizacion_completada_en = now()
        WHERE p.id = $1
          AND p.caracterizacion_completada_en IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM survey_question q
                 WHERE q.estado='activo'
                   AND NOT EXISTS (SELECT 1 FROM survey_answer a
                                    WHERE a.question_id=q.id AND a.person_id=p.id))
        RETURNING id`,
      [personId],
    );
    if (r.rowCount) return true;
    const ya = await pool.query(
      `SELECT caracterizacion_completada_en IS NOT NULL AS ok FROM person WHERE id=$1`, [personId],
    );
    return Boolean(ya.rows[0]?.ok);
  } catch (e) {
    log.warn('caracterizacion: cerrarSiCompleta falló', { err: String(e) });
    return false;
  }
}

/** ¿La persona ya completó la caracterización? Es el requisito para iniciar la ruta curricular. */
export async function estaCompleta(personId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(
      `SELECT caracterizacion_completada_en IS NOT NULL AS ok FROM person WHERE id=$1`, [personId],
    );
    return Boolean(r.rows[0]?.ok);
  } catch (e) {
    log.warn('caracterizacion: estaCompleta falló', { err: String(e) });
    return false;
  }
}

/**
 * Perfil del estudiante: sus respuestas por código de pregunta.
 *
 * Se usa para dar contexto al tutor (edad, situación laboral, expectativa) y para el reporte
 * institucional. El plan no define personalización de ruta a partir de esto, así que el tutor lo
 * recibe como contexto de trato, no como instrucción de saltarse contenidos.
 */
export async function perfil(personId: string): Promise<Record<string, string>> {
  const pool = getPool();
  if (!pool) return {};
  try {
    const r = await pool.query(
      `SELECT q.codigo, o.texto
         FROM survey_answer a
         JOIN survey_question q ON q.id=a.question_id
         JOIN survey_option o ON o.id=a.option_id
        WHERE a.person_id=$1
        ORDER BY q.orden`,
      [personId],
    );
    return Object.fromEntries(r.rows.map((x: any) => [x.codigo, x.texto]));
  } catch (e) {
    log.warn('caracterizacion: perfil falló', { err: String(e) });
    return {};
  }
}
