import { getPool } from './db';
import { log } from '../log';

// Repositorio de evaluaciones formativas (Fase 7). Registro transaccional por respuesta:
// attempt_answer + contador del attempt (+ cierre) en UNA tx — nada de notas perdidas en silencio.

export type PreguntaConOpciones = {
  id: string;
  orden: number;
  tipo: 'seleccion_multiple' | 'verdadero_falso';
  enunciado: string;
  explicacion: string;
  opciones: { id: string; orden: number; texto: string; esCorrecta: boolean }[];
};

export type QuizIniciado = {
  attemptId: string;
  quizId: string;
  titulo: string;
  intentoN: number;
  total: number;
  primera: PreguntaConOpciones;
};

/** Quiz asociado a una lección (o null). */
export async function quizDeLeccion(lessonId: string): Promise<{ id: string; titulo: string } | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT id, titulo FROM quiz WHERE lesson_id=$1 AND estado='activo'`, [lessonId]);
    return r.rows[0] ?? null;
  } catch (e) {
    log.warn('evaluaciones: quizDeLeccion falló', { err: String(e) });
    return null;
  }
}

/** Quiz a iniciar para la persona: el de la lección COMPLETADA más reciente sin intento finalizado;
 *  si todos tienen intento finalizado, el más reciente (para repetir como práctica). */
export async function quizParaIniciar(personId: string): Promise<{ quizId: string; titulo: string; enrollmentId: string } | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `WITH completadas AS (
         SELECT q.id AS quiz_id, q.titulo, e.id AS enrollment_id, lp.completado_en,
                EXISTS (SELECT 1 FROM quiz_attempt qa
                        WHERE qa.quiz_id = q.id AND qa.enrollment_id = e.id AND qa.finalizado_en IS NOT NULL) AS ya_rendido
         FROM enrollment e
         JOIN lesson_progress lp ON lp.enrollment_id = e.id AND lp.estado='completada'
         JOIN quiz q ON q.lesson_id = lp.lesson_id AND q.estado='activo'
         WHERE e.person_id = $1
       )
       SELECT quiz_id, titulo, enrollment_id FROM completadas
       ORDER BY ya_rendido ASC, completado_en DESC LIMIT 1`,
      [personId],
    );
    const row = r.rows[0];
    return row ? { quizId: row.quiz_id, titulo: row.titulo, enrollmentId: row.enrollment_id } : null;
  } catch (e) {
    log.warn('evaluaciones: quizParaIniciar falló', { err: String(e) });
    return null;
  }
}

async function preguntaPorOrden(quizId: string, orden: number): Promise<PreguntaConOpciones | null> {
  const pool = getPool();
  if (!pool) return null;
  const q = await pool.query(`SELECT id, orden, tipo, enunciado, explicacion FROM question WHERE quiz_id=$1 AND orden=$2`, [quizId, orden]);
  const row = q.rows[0];
  if (!row) return null;
  const ops = await pool.query(`SELECT id, orden, texto, es_correcta FROM question_option WHERE question_id=$1 ORDER BY orden`, [row.id]);
  return {
    id: row.id, orden: row.orden, tipo: row.tipo, enunciado: row.enunciado, explicacion: row.explicacion,
    opciones: ops.rows.map((o: any) => ({ id: o.id, orden: o.orden, texto: o.texto, esCorrecta: o.es_correcta })),
  };
}

/** Crea un intento nuevo (intento_n = último+1) y devuelve la primera pregunta. */
export async function iniciarAttempt(enrollmentId: string, quizId: string): Promise<QuizIniciado | null> {
  const pool = getPool();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(`SELECT count(*)::int AS total, (SELECT titulo FROM quiz WHERE id=$1) AS titulo FROM question WHERE quiz_id=$1`, [quizId]);
    const total = t.rows[0]?.total ?? 0;
    if (!total) { await client.query('ROLLBACK'); return null; }
    const n = await client.query(
      `SELECT COALESCE(MAX(intento_n),0)+1 AS n FROM quiz_attempt WHERE enrollment_id=$1 AND quiz_id=$2`,
      [enrollmentId, quizId],
    );
    const intentoN = n.rows[0].n;
    const a = await client.query(
      `INSERT INTO quiz_attempt (enrollment_id, quiz_id, intento_n, total) VALUES ($1,$2,$3,$4) RETURNING id`,
      [enrollmentId, quizId, intentoN, total],
    );
    await client.query('COMMIT');
    const primera = await preguntaPorOrden(quizId, 1);
    if (!primera) return null;
    return { attemptId: a.rows[0].id, quizId, titulo: t.rows[0].titulo, intentoN, total, primera };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('evaluaciones: iniciarAttempt falló', { err: String(e) });
    return null;
  } finally {
    client.release();
  }
}

export type ResultadoRespuesta = {
  esCorrecta: boolean;
  correctaTexto: string;
  explicacion: string;
  correctas: number;
  total: number;
  siguiente: PreguntaConOpciones | null;
  finalizado: boolean;
};

/** Registra una respuesta (tx: answer + contador + cierre si es la última) y trae la siguiente. */
export async function registrarRespuesta(
  attemptId: string, quizId: string, pregunta: PreguntaConOpciones, optionId: string,
  tiempoMs: number | null, explicacionEnviada: string,
): Promise<ResultadoRespuesta | null> {
  const pool = getPool();
  if (!pool) return null;
  const elegida = pregunta.opciones.find((o) => o.id === optionId);
  const correcta = pregunta.opciones.find((o) => o.esCorrecta);
  if (!elegida || !correcta) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO attempt_answer (attempt_id, question_id, option_id, es_correcta, tiempo_respuesta_ms, explicacion_enviada)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ON CONSTRAINT attempt_answer_unico DO NOTHING`,
      [attemptId, pregunta.id, elegida.id, elegida.esCorrecta, tiempoMs, explicacionEnviada],
    );
    const upd = await client.query(
      `UPDATE quiz_attempt SET correctas = (SELECT count(*)::int FROM attempt_answer WHERE attempt_id=$1 AND es_correcta)
       WHERE id=$1 RETURNING correctas, total`,
      [attemptId],
    );
    const { correctas, total } = upd.rows[0];
    const respondidas = await client.query(`SELECT count(*)::int AS n FROM attempt_answer WHERE attempt_id=$1`, [attemptId]);
    const finalizado = respondidas.rows[0].n >= total;
    if (finalizado) await client.query(`UPDATE quiz_attempt SET finalizado_en=now() WHERE id=$1`, [attemptId]);
    await client.query('COMMIT');
    const siguiente = finalizado ? null : await preguntaPorOrden(quizId, pregunta.orden + 1);
    return { esCorrecta: elegida.esCorrecta, correctaTexto: correcta.texto, explicacion: pregunta.explicacion, correctas, total, siguiente, finalizado };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('evaluaciones: registrarRespuesta falló', { err: String(e) });
    return null;
  } finally {
    client.release();
  }
}
