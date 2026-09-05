import { getPool } from './db';
import { log } from '../log';

// Repositorio de recordatorios (Fase 9). El INSERT con ON CONFLICT (clave_dedupe) DO NOTHING es el
// corazón del dedupe fail-closed: la unicidad vive en Postgres, no en Redis.

export type CandidatoRecordatorio = {
  personId: string;
  waId: string;
  nombre: string | null;
  cursoNombre: string;
  proximaLeccion: string | null;
  enviadosSinActividad: number;
};

/** Inscritos activos con opt-in vigente e inactividad ≥ diasInactividad (sin progreso ni entrega reciente). */
export async function candidatosContinuarCurso(diasInactividad: number): Promise<CandidatoRecordatorio[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      `WITH ultima_actividad AS (
         SELECT e.id AS enrollment_id, e.person_id, c.nombre AS curso_nombre,
                GREATEST(e.iniciado_en, COALESCE(MAX(lp.entregado_en), e.iniciado_en), COALESCE(MAX(lp.completado_en), e.iniciado_en)) AS ultima
         FROM enrollment e
         JOIN course c ON c.id = e.course_id AND c.estado = 'activo'
         LEFT JOIN lesson_progress lp ON lp.enrollment_id = e.id
         WHERE e.estado = 'activa'
         GROUP BY e.id, e.person_id, c.nombre
       ),
       optin AS (
         SELECT DISTINCT ON (person_id) person_id, otorgado
         FROM consent WHERE tipo = 'recordatorios' ORDER BY person_id, ts DESC
       )
       SELECT ua.person_id, pi.valor_lookup AS wa_id, p.nombre, ua.curso_nombre,
              (SELECT l.titulo FROM lesson l JOIN module m ON m.id = l.module_id
                JOIN enrollment e2 ON e2.id = ua.enrollment_id AND m.course_id = e2.course_id
                WHERE NOT EXISTS (SELECT 1 FROM lesson_progress lp2
                                  WHERE lp2.enrollment_id = ua.enrollment_id AND lp2.lesson_id = l.id AND lp2.estado='completada')
                ORDER BY m.orden, l.orden LIMIT 1) AS proxima,
              (SELECT count(*)::int FROM reminder rm
                WHERE rm.person_id = ua.person_id AND rm.tipo='continuar_curso'
                  AND rm.estado='enviado' AND rm.enviado_en > ua.ultima) AS enviados_sin_actividad
       FROM ultima_actividad ua
       JOIN optin o ON o.person_id = ua.person_id AND o.otorgado
       JOIN person p ON p.id = ua.person_id
       JOIN person_identity pi ON pi.person_id = ua.person_id AND pi.tipo = 'wa_id'
       WHERE ua.ultima < now() - ($1 || ' days')::interval
         -- Espaciado REAL (revisión F9.1): nada pendiente ni enviado en los últimos N días —
         -- la clave_dedupe por bloques de epoch permitía dos envíos cercanos en el borde de bloque.
         AND NOT EXISTS (
           SELECT 1 FROM reminder rm2
           WHERE rm2.person_id = ua.person_id AND rm2.tipo = 'continuar_curso'
             AND (rm2.estado = 'programado'
                  OR (rm2.estado = 'enviado' AND rm2.enviado_en > now() - ($1 || ' days')::interval))
         )`,
      [String(diasInactividad)],
    );
    return r.rows.map((row: any) => ({
      personId: row.person_id, waId: row.wa_id, nombre: row.nombre,
      cursoNombre: row.curso_nombre, proximaLeccion: row.proxima, enviadosSinActividad: row.enviados_sin_actividad,
    }));
  } catch (e) {
    log.warn('recordatorios: candidatos falló', { err: String(e) });
    return [];
  }
}

/** Programa un recordatorio. Devuelve true si se creó (false = ya existía la clave_dedupe: dedupe). */
export async function programarRecordatorio(
  personId: string, tipo: string, claveDedupe: string, programadoPara: Date,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(
      `INSERT INTO reminder (person_id, tipo, clave_dedupe, programado_para)
       VALUES ($1,$2,$3,$4) ON CONFLICT (clave_dedupe) DO NOTHING RETURNING id`,
      [personId, tipo, claveDedupe, programadoPara.toISOString()],
    );
    return r.rows.length > 0;
  } catch (e) {
    log.warn('recordatorios: programar falló', { err: String(e) });
    return false;
  }
}

export type RecordatorioPendiente = {
  id: string;
  personId: string;
  tipo: string;
  intentos: number;
  waId: string;
  nombre: string | null;
  programadoPara: Date;
};

/** Recordatorios programados vencidos, con el wa_id de la persona. */
export async function pendientesDeDespacho(limit: number): Promise<RecordatorioPendiente[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT rm.id, rm.person_id, rm.tipo, rm.intentos, rm.programado_para, pi.valor_lookup AS wa_id, p.nombre
       FROM reminder rm
       JOIN person p ON p.id = rm.person_id
       JOIN person_identity pi ON pi.person_id = rm.person_id AND pi.tipo = 'wa_id'
       WHERE rm.estado = 'programado' AND rm.programado_para <= now()
       ORDER BY rm.programado_para LIMIT $1`,
      [limit],
    );
    return r.rows.map((row: any) => ({
      id: row.id, personId: row.person_id, tipo: row.tipo, intentos: row.intentos,
      waId: row.wa_id, nombre: row.nombre, programadoPara: new Date(row.programado_para),
    }));
  } catch (e) {
    log.warn('recordatorios: pendientes falló', { err: String(e) });
    return [];
  }
}

// ── Transiciones (revisión F9.1: semántica AT-MOST-ONCE) ──────────────────────
// El despachador RECLAMA la fila (programado→enviado) ANTES de tocar la red: si el proceso muere
// tras enviar, la fila ya está 'enviado' y nadie re-envía. Perder un recordatorio ante un fallo
// raro es aceptable; duplicárselo al estudiante, no.

/** Reclama la fila para envío. false = otro job ya la tomó (o cambió de estado). */
export async function reclamarParaEnvio(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(
      `UPDATE reminder SET estado='enviado', enviado_en=now() WHERE id=$1 AND estado='programado' RETURNING id`,
      [id],
    );
    return r.rows.length > 0;
  } catch (e) {
    log.warn('recordatorios: reclamar falló', { err: String(e) });
    return false;
  }
}

/** Guarda el wamid del envío exitoso (para correlacionar statuses). Best-effort. */
export async function registrarWamid(id: string, waMessageId: string | null): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE reminder SET wa_message_id=$2 WHERE id=$1`, [id, waMessageId]);
  } catch (e) {
    log.warn('recordatorios: registrarWamid falló', { err: String(e) });
  }
}

/** Devuelve una fila reclamada a 'programado' (fallo de envío → reintento futuro). */
export async function devolverAProgramado(id: string, intentos: number, cuando: Date): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE reminder SET estado='programado', enviado_en=NULL, intentos=$2, programado_para=$3 WHERE id=$1 AND estado='enviado'`,
      [id, intentos, cuando.toISOString()],
    );
  } catch (e) {
    log.warn('recordatorios: devolverAProgramado falló', { err: String(e) });
  }
}

/** Re-agenda una fila aún no reclamada (fuera de ventana horaria). */
export async function reprogramar(id: string, cuando: Date): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE reminder SET programado_para=$2 WHERE id=$1 AND estado='programado'`,
      [id, cuando.toISOString()],
    );
  } catch (e) {
    log.warn('recordatorios: reprogramar falló', { err: String(e) });
  }
}

/** Marca un estado terminal (cancelado | omitido | fallido). */
export async function marcarEstado(id: string, estado: 'cancelado' | 'omitido' | 'fallido'): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE reminder SET estado=$2 WHERE id=$1`, [id, estado]);
  } catch (e) {
    log.warn('recordatorios: marcarEstado falló', { err: String(e) });
  }
}

/** Cancela todos los programados de una persona (opt-out). */
export async function cancelarDePersona(personId: string): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const r = await pool.query(`UPDATE reminder SET estado='cancelado' WHERE person_id=$1 AND estado='programado'`, [personId]);
    return r.rowCount ?? 0;
  } catch (e) {
    log.warn('recordatorios: cancelar falló', { err: String(e) });
    return 0;
  }
}

/** Un status 'failed' del webhook marca el recordatorio como fallido (correlación por wamid). */
export async function marcarFallidoPorWamid(waMessageId: string): Promise<void> {
  const pool = getPool();
  if (!pool || !waMessageId) return;
  try {
    await pool.query(`UPDATE reminder SET estado='fallido' WHERE wa_message_id=$1 AND estado='enviado'`, [waMessageId]);
  } catch (e) {
    log.warn('recordatorios: marcarFallidoPorWamid falló', { err: String(e) });
  }
}
