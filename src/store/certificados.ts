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

/** Datos que identifican un certificado hacia afuera: el folio y el código de la URL pública. */
export type Emision = { folio: string; codigo: string };

/**
 * Emite el certificado: asigna folio de la secuencia, genera el código de verificación y pasa a
 * 'emitido'. Idempotente por estado (un reintento de envío devuelve los datos ya asignados).
 */
export async function emitir(id: string): Promise<Emision | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `UPDATE certificate
       SET estado='emitido', emitido_en=now(),
           folio='ATLAS-' || to_char(now(),'YYYY') || '-' || lpad(nextval('certificate_folio_seq')::text, 4, '0'),
           codigo_verificacion=encode(gen_random_bytes(8), 'hex')
       WHERE id=$1 AND estado IN ('elegible','datos_pendientes')
       RETURNING folio, codigo_verificacion`,
      [id],
    );
    const fila = r.rows[0]
      ?? (await pool.query(`SELECT folio, codigo_verificacion FROM certificate WHERE id=$1`, [id])).rows[0];
    // El segundo SELECT cubre el reintento de envío: ya estaba emitido y hay que devolver lo asignado.
    return fila?.folio ? { folio: fila.folio, codigo: fila.codigo_verificacion ?? '' } : null;
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

/** Lo que muestra la página pública de verificación. */
export type CertificadoVerificado = {
  folio: string;
  nombre: string;
  curso: string;
  minutos: number;
  emitidoEn: Date;
};

/**
 * Busca un certificado por folio Y código. Exige los dos a propósito: el folio es secuencial, así
 * que resolver solo por folio permitiría recorrer la cohorte completa y sacar el nombre y el curso
 * de cada estudiante. Devuelve null ante cualquier discrepancia, sin distinguir "folio inexistente"
 * de "código incorrecto" (esa distinción sería, ella misma, un oráculo de enumeración).
 */
export async function verificarPorFolio(folio: string, codigo: string): Promise<CertificadoVerificado | null> {
  const pool = getPool();
  if (!pool) return null;
  if (!folio || !codigo) return null;
  try {
    const r = await pool.query(
      `SELECT ct.folio, ct.emitido_en, p.nombre, p.apellido, c.nombre AS curso_nombre, e.minutos_acumulados
       FROM certificate ct
       JOIN person p ON p.id = ct.person_id
       JOIN enrollment e ON e.id = ct.enrollment_id
       JOIN course c ON c.id = e.course_id
       WHERE ct.folio = $1 AND ct.codigo_verificacion = $2 AND ct.estado IN ('emitido','enviado')`,
      [folio, codigo],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      folio: row.folio,
      nombre: [row.nombre, row.apellido].filter(Boolean).join(' '),
      curso: row.curso_nombre,
      minutos: row.minutos_acumulados,
      emitidoEn: row.emitido_en,
    };
  } catch (e) {
    log.warn('certificados: verificarPorFolio falló', { err: String(e) });
    return null;
  }
}
