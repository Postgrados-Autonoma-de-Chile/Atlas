import { getPool } from './db';
import { log } from '../log';

// Repositorio de certificados (Fase 8). La creación de la fila 'elegible' vive en la transacción
// de completarLeccionActual (cursos.ts); aquí van consultas y transiciones.

export type Certificado = {
  id: string;
  estado: 'elegible' | 'datos_pendientes' | 'emitido' | 'enviado';
  folio: string | null;
  cursoNombre: string;
  minutos: number;
};

/** Certificado de la persona en el curso activo (el piloto tiene un curso). null si no hay. */
export async function certificadoDePersona(personId: string): Promise<Certificado | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT ct.id, ct.estado, ct.folio, c.nombre AS curso_nombre, e.minutos_acumulados
       FROM certificate ct
       JOIN enrollment e ON e.id = ct.enrollment_id
       JOIN course c ON c.id = e.course_id
       WHERE ct.person_id = $1
       ORDER BY ct.created_at DESC LIMIT 1`,
      [personId],
    );
    const row = r.rows[0];
    return row
      ? { id: row.id, estado: row.estado, folio: row.folio, cursoNombre: row.curso_nombre, minutos: row.minutos_acumulados }
      : null;
  } catch (e) {
    log.warn('certificados: certificadoDePersona falló', { err: String(e) });
    return null;
  }
}

export async function marcarDatosPendientes(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE certificate SET estado='datos_pendientes' WHERE id=$1 AND estado='elegible'`, [id]);
  } catch (e) {
    log.warn('certificados: marcarDatosPendientes falló', { err: String(e) });
  }
}

/** Emite el certificado: asigna folio de la secuencia y pasa a 'emitido'. Idempotente por estado. */
export async function emitir(id: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `UPDATE certificate
       SET estado='emitido', emitido_en=now(),
           folio='ATLAS-' || to_char(now(),'YYYY') || '-' || lpad(nextval('certificate_folio_seq')::text, 4, '0')
       WHERE id=$1 AND estado IN ('elegible','datos_pendientes')
       RETURNING folio`,
      [id],
    );
    if (r.rows[0]) return r.rows[0].folio;
    // Ya estaba emitido (reintento de envío): devolver el folio existente.
    const ya = await pool.query(`SELECT folio FROM certificate WHERE id=$1`, [id]);
    return ya.rows[0]?.folio ?? null;
  } catch (e) {
    log.error('certificados: emitir falló', { err: String(e) });
    return null;
  }
}

export async function marcarEnviado(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE certificate SET estado='enviado', enviado_en=now() WHERE id=$1 AND estado='emitido'`, [id]);
  } catch (e) {
    log.warn('certificados: marcarEnviado falló', { err: String(e) });
  }
}
