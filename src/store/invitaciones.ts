import { getPool } from './db';
import { log } from '../log';
import { normalizarE164 } from '../messaging';

// Cola de convocatoria. Mismo patrón que store/recordatorios: reclamo ATÓMICO antes de enviar, para
// que dos réplicas del job no manden (ni paguen) dos veces la misma plantilla.

export type EstadoInvitacion = 'pendiente' | 'enviada' | 'respondio' | 'fallida' | 'descartada';

export type CandidataInvitacion = {
  id: string;
  telefono: string;
  nombre: string | null;
  intentos: number;
};

/**
 * Carga un listado. Idempotente por el UNIQUE de telefono: recargar el mismo archivo no duplica ni
 * reenvía. Devuelve cuántas entraron y cuántas ya existían, para que quien carga vea qué pasó.
 *
 * Los teléfonos se normalizan a E.164 acá y no en el llamador: un mismo número escrito de tres
 * formas distintas en una planilla debe colapsar a una sola invitación, no a tres.
 */
export async function cargarLote(
  entradas: { telefono: string; nombre?: string | null }[],
  lote: string,
): Promise<{ insertadas: number; duplicadas: number; invalidas: string[] }> {
  const pool = getPool();
  if (!pool) throw new Error('SIN_DB');

  const vistos = new Set<string>();
  const validas: { telefono: string; nombre: string | null }[] = [];
  const invalidas: string[] = [];

  for (const e of entradas ?? []) {
    const tel = normalizarE164(String(e?.telefono ?? ''));
    // Un móvil chileno en E.164 son 12 caracteres (+569XXXXXXXX); se acepta cualquier E.164 plausible.
    if (!tel || !/^\+\d{8,15}$/.test(tel)) {
      invalidas.push(String(e?.telefono ?? ''));
      continue;
    }
    if (vistos.has(tel)) continue; // duplicado DENTRO del mismo archivo
    vistos.add(tel);
    validas.push({ telefono: tel, nombre: e?.nombre?.trim() || null });
  }
  if (!validas.length) return { insertadas: 0, duplicadas: 0, invalidas };

  const valores = validas.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
  const params = validas.flatMap((v) => [v.telefono, v.nombre, lote]);
  const r = await pool.query(
    `INSERT INTO invitation (telefono, nombre, lote) VALUES ${valores}
     ON CONFLICT (telefono) DO NOTHING
     RETURNING id`,
    params,
  );
  const insertadas = r.rowCount ?? 0;
  return { insertadas, duplicadas: validas.length - insertadas, invalidas };
}

/**
 * Candidatas a recibir la plantilla: sin Persona todavía, y pendientes o fallidas con intentos por
 * debajo del tope.
 *
 * El NOT EXISTS contra person_identity es la pieza que ahorra dinero: quien ya llegó por el QR está
 * registrado, y mandarle una invitación sería pagar una plantilla para invitar a alguien que ya está
 * dentro. Se resuelve en SQL y no por candidato para que a escala de cohorte sea una sola consulta.
 *
 * Se reintentan las FALLIDAS porque un ok:false del proveedor es él diciendo que NO envió: reintentar
 * no arriesga pagar dos veces. El tope de intentos evita insistir contra un número que no existe.
 */
export async function candidatasParaEnviar(limite: number, maxIntentos: number): Promise<CandidataInvitacion[]> {
  const pool = getPool();
  if (!pool) throw new Error('SIN_DB');
  const r = await pool.query(
    `SELECT i.id, i.telefono, i.nombre, i.intentos
       FROM invitation i
      WHERE (i.estado = 'pendiente' OR (i.estado = 'fallida' AND i.intentos < $2))
        AND NOT EXISTS (
          SELECT 1 FROM person_identity pi
           WHERE pi.tipo = 'wa_id' AND pi.valor_lookup = i.telefono
        )
      ORDER BY i.estado, i.created_at
      LIMIT $1`,
    [limite, maxIntentos],
  );
  return r.rows;
}

/** Pendientes que YA tienen Persona: llegaron por el QR. Se descartan sin enviar nada. */
export async function descartarYaRegistradas(): Promise<number> {
  const pool = getPool();
  if (!pool) throw new Error('SIN_DB');
  const r = await pool.query(
    `UPDATE invitation i
        SET estado = 'descartada', motivo_descarte = 'ya registrado (llegó por QR o enlace)'
      WHERE i.estado IN ('pendiente','fallida')
        AND EXISTS (
          SELECT 1 FROM person_identity pi
           WHERE pi.tipo = 'wa_id' AND pi.valor_lookup = i.telefono
        )`,
  );
  return r.rowCount ?? 0;
}

/**
 * Reclama la invitación para envío, atómicamente. Devuelve false si otra réplica ya la tomó.
 * Acepta reintentar una fallida; el tope de intentos lo aplica la consulta de candidatas.
 * Se marca 'enviada' ANTES del envío real: ante una caída a mitad de camino se prefiere no enviar
 * (y que la persona llegue por el QR) a enviar dos veces y pagar dos plantillas.
 */
export async function reclamarParaEnvio(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error('SIN_DB');
  const r = await pool.query(
    `UPDATE invitation
        SET estado = 'enviada', enviada_en = now(), intentos = intentos + 1
      WHERE id = $1 AND estado IN ('pendiente','fallida')
      RETURNING id`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function registrarWamid(id: string, waMessageId: string | null): Promise<void> {
  const pool = getPool();
  if (!pool || !waMessageId) return;
  try {
    await pool.query(`UPDATE invitation SET wa_message_id = $2 WHERE id = $1`, [id, waMessageId]);
  } catch (e) {
    log.warn('invitaciones: no se pudo registrar el wamid', { err: String(e) });
  }
}

/** El envío falló tras reclamar. Se marca fallida (no vuelve a pendiente: el intento ya se contó). */
export async function marcarFallida(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE invitation SET estado = 'fallida' WHERE id = $1`, [id]);
  } catch (e) {
    log.warn('invitaciones: no se pudo marcar fallida', { err: String(e) });
  }
}

/**
 * Marca que el número escribió. La llama el webhook en CADA mensaje entrante, así que es
 * best-effort y silenciosa: nunca debe romper el turno de un estudiante.
 * Cubre las dos vías — llegó por el QR sin haber recibido plantilla, o respondió a la que recibió.
 */
export async function marcarRespondio(telefono: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE invitation
          SET estado = 'respondio', respondio_en = now()
        WHERE telefono = $1 AND estado IN ('pendiente','enviada','fallida')`,
      [telefono],
    );
  } catch (e) {
    log.warn('invitaciones: no se pudo marcar respondio', { err: String(e) });
  }
}

/** Marca fallida por el status del webhook (failed), correlacionando por wamid. */
export async function marcarFallidaPorWamid(waMessageId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE invitation SET estado = 'fallida' WHERE wa_message_id = $1 AND estado = 'enviada'`,
      [waMessageId],
    );
  } catch (e) {
    log.warn('invitaciones: no se pudo marcar fallida por wamid', { err: String(e) });
  }
}

export type ResumenConvocatoria = {
  porEstado: Record<string, number>;
  total: number;
  /** Enviadas del día, para respetar el cupo diario del tramo de Meta. */
  enviadasHoy: number;
};

export async function resumen(): Promise<ResumenConvocatoria | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const [porEstado, hoy] = await Promise.all([
      pool.query(`SELECT estado, count(*)::int AS n FROM invitation GROUP BY estado`),
      pool.query(`SELECT count(*)::int AS n FROM invitation WHERE enviada_en >= now() - interval '24 hours'`),
    ]);
    const mapa: Record<string, number> = {};
    let total = 0;
    for (const row of porEstado.rows) {
      mapa[row.estado] = row.n;
      total += row.n;
    }
    return { porEstado: mapa, total, enviadasHoy: hoy.rows[0]?.n ?? 0 };
  } catch (e) {
    log.warn('invitaciones: resumen falló', { err: String(e) });
    return null;
  }
}
