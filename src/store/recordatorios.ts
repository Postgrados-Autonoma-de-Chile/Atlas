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
       WHERE ua.ultima < now() - ($1 || ' days')::interval`,
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
};

/** Recordatorios programados vencidos, con el wa_id de la persona. */
export async function pendientesDeDespacho(limit: number): Promise<RecordatorioPendiente[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT rm.id, rm.person_id, rm.tipo, rm.intentos, pi.valor_lookup AS wa_id, p.nombre
       FROM reminder rm
       JOIN person p ON p.id = rm.person_id
       JOIN person_identity pi ON pi.person_id = rm.person_id AND pi.tipo = 'wa_id'
       WHERE rm.estado = 'programado' AND rm.programado_para <= now()
       ORDER BY rm.programado_para LIMIT $1`,
      [limit],
    );
    return r.rows.map((row: any) => ({
      id: row.id, personId: row.person_id, tipo: row.tipo, intentos: row.intentos, waId: row.wa_id, nombre: row.nombre,
    }));
  } catch (e) {
    log.warn('recordatorios: pendientes falló', { err: String(e) });
    return [];
  }
}

/** Transición de estado con guarda optimista (solo desde 'programado'). */
export async function transicionar(
  id: string,
  cambios: { estado?: string; enviadoEn?: boolean; waMessageId?: string | null; intentos?: number; programadoPara?: Date },
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const sets: string[] = [];
  const vals: any[] = [];
  const add = (frag: string, v: any) => { vals.push(v); sets.push(`${frag}$${vals.length}`); };
  if (cambios.estado) add('estado = ', cambios.estado);
  if (cambios.enviadoEn) sets.push('enviado_en = now()');
  if (cambios.waMessageId !== undefined) add('wa_message_id = ', cambios.waMessageId);
  if (cambios.intentos !== undefined) add('intentos = ', cambios.intentos);
  if (cambios.programadoPara) add('programado_para = ', cambios.programadoPara.toISOString());
  if (!sets.length) return;
  vals.push(id);
  try {
    await pool.query(`UPDATE reminder SET ${sets.join(', ')} WHERE id = $${vals.length} AND estado = 'programado'`, vals);
  } catch (e) {
    log.warn('recordatorios: transicionar falló', { err: String(e) });
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
