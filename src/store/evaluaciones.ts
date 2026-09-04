import { getPool } from './db';
import { log } from '../log';

// Repositorio de evaluaciones formativas (Fase 7). Registro transaccional por respuesta:
// attempt_answer + contador del attempt (+ cierre) en UNA tx — nada de notas perdidas en silencio.

export type PreguntaConOpciones = {
  id: string;
  orden: number;
  tipo: 'seleccion_multiple' | 'verdadero_falso' | 'clasificacion' | 'eleccion' | 'abierta';
  enunciado: string;
  explicacion: string;
  /**
   * Hay ítems SIN respuesta correcta por diseño curricular: la cápsula 6 pide elegir al menos dos
   * casos de interés y la 8 elegir entre un problema propio o uno preparado — su documento dice
   * que ambas opciones son válidas. Con esta bandera el flujo acusa recibo y entrega el criterio,
   * sin calificar: llamar "incorrecta" a una elección legítima sería un error pedagógico.
   */
  sinRespuestaCorrecta: boolean;
  /** En una clasificación, el fragmento que se está ubicando (las opciones son las categorías). */
  itemTexto: string | null;
  opciones: { id: string; orden: number; texto: string; esCorrecta: boolean }[];
};

/** Metadatos del momento "Lo intento" que el plan curricular exige en cada microcápsula. */
export type Interaccion = {
  tipo: 'seleccion_unica' | 'clasificacion' | 'seleccion_multiple' | 'eleccion';
  consigna: string | null;
  /** Retroalimentación del documento: explica el CRITERIO. Se entrega UNA vez, al cerrar. */
  retroalimentacion: string | null;
  minimoRequerido: number;
};

export type QuizIniciado = {
  attemptId: string;
  quizId: string;
  titulo: string;
  intentoN: number;
  total: number;
  primera: PreguntaConOpciones;
  interaccion: Interaccion;
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
/**
 * Cuántos mini-quizzes de microcápsulas YA COMPLETADAS le quedan sin rendir.
 *
 * Existe porque el quiz automático solo se dispara al completar una microcápsula: quien terminó el
 * curso —o lo recorrió cuando el quiz era opcional— acumula evaluaciones pendientes que de otro
 * modo quedarían invisibles, descubribles solo si adivina la palabra "quiz". Las herramientas de
 * progreso lo informan para que el tutor pueda ofrecerlas.
 */
export async function quizzesPendientes(personId: string): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n
         FROM enrollment e
         JOIN lesson_progress lp ON lp.enrollment_id = e.id AND lp.estado = 'completada'
         JOIN quiz q ON q.lesson_id = lp.lesson_id AND q.estado = 'activo'
        WHERE e.person_id = $1
          AND NOT EXISTS (
                SELECT 1 FROM quiz_attempt qa
                 WHERE qa.quiz_id = q.id AND qa.enrollment_id = e.id AND qa.finalizado_en IS NOT NULL
              )`,
      [personId],
    );
    return r.rows[0]?.n ?? 0;
  } catch (e) {
    log.warn('evaluaciones: quizzesPendientes falló', { err: String(e) });
    return 0;
  }
}

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
  const q = await pool.query(
    `SELECT id, orden, tipo, enunciado, explicacion, sin_respuesta_correcta, item_texto
       FROM question WHERE quiz_id=$1 AND orden=$2`,
    [quizId, orden],
  );
  const row = q.rows[0];
  if (!row) return null;
  const ops = await pool.query(`SELECT id, orden, texto, es_correcta FROM question_option WHERE question_id=$1 ORDER BY orden`, [row.id]);
  return {
    id: row.id, orden: row.orden, tipo: row.tipo, enunciado: row.enunciado, explicacion: row.explicacion,
    sinRespuestaCorrecta: Boolean(row.sin_respuesta_correcta), itemTexto: row.item_texto ?? null,
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
    const t = await client.query(
      `SELECT count(q.id)::int AS total,
              z.titulo, z.tipo_interaccion, z.consigna, z.retroalimentacion, z.minimo_requerido
         FROM quiz z LEFT JOIN question q ON q.quiz_id = z.id
        WHERE z.id = $1
        GROUP BY z.titulo, z.tipo_interaccion, z.consigna, z.retroalimentacion, z.minimo_requerido`,
      [quizId],
    );
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
    const f = t.rows[0];
    return {
      attemptId: a.rows[0].id, quizId, titulo: f.titulo, intentoN, total, primera,
      interaccion: {
        tipo: f.tipo_interaccion ?? 'seleccion_unica',
        consigna: f.consigna ?? null,
        retroalimentacion: f.retroalimentacion ?? null,
        // El mínimo no puede exceder los ítems existentes, o la actividad nunca cerraría.
        minimoRequerido: Math.min(Math.max(1, f.minimo_requerido ?? 1), total),
      },
    };
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
  /** Vacío cuando la pregunta no tiene respuesta correcta por diseño. */
  correctaTexto: string;
  explicacion: string;
  sinRespuestaCorrecta: boolean;
  elegidaTexto: string;
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
  if (!elegida) return null;
  // Sin respuesta correcta no hay "correcta" que buscar: la elección se registra tal cual. Exigir
  // que exista, como antes, dejaba inutilizables las cápsulas 6 y 8 del plan.
  if (!pregunta.sinRespuestaCorrecta && !correcta) return null;
  const acertada = pregunta.sinRespuestaCorrecta ? true : elegida.esCorrecta;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO attempt_answer (attempt_id, question_id, option_id, es_correcta, tiempo_respuesta_ms, explicacion_enviada)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ON CONSTRAINT attempt_answer_unico DO NOTHING`,
      [attemptId, pregunta.id, elegida.id, acertada, tiempoMs, explicacionEnviada],
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
    // Lectura POST-commit en try propio (revisión F9.1): si fallara, la respuesta YA quedó guardada
    // — devolver el resultado sin siguiente (el flujo cierra el quiz con resumen), jamás null
    // (que mostraba "problema guardando tu respuesta" siendo falso).
    let siguiente: PreguntaConOpciones | null = null;
    if (!finalizado) {
      try {
        siguiente = await preguntaPorOrden(quizId, pregunta.orden + 1);
      } catch (e) {
        log.warn('evaluaciones: no se pudo leer la siguiente pregunta (respuesta ya guardada)', { err: String(e) });
      }
    }
    return {
      esCorrecta: acertada,
      correctaTexto: correcta?.texto ?? '',
      explicacion: pregunta.explicacion,
      sinRespuestaCorrecta: pregunta.sinRespuestaCorrecta,
      elegidaTexto: elegida.texto,
      correctas, total, siguiente, finalizado,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('evaluaciones: registrarRespuesta falló', { err: String(e) });
    return null;
  } finally {
    client.release();
  }
}
