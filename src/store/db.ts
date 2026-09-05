import pg from 'pg';
import { config } from '../config';
import { log } from '../log';
import { once } from './kv';
import { inc } from '../obs/metrics';

// Postgres: desde la Fase 3 es la FUENTE DE VERDAD de identidad (y pronto de progreso académico).
// El esquema vive en migrations/ (npm run migrate) — ya no hay DDL inline. Política fail-fast:
// en producción, si la BD no está disponible o el esquema no está migrado, el proceso NO arranca.
// En desarrollo sin DATABASE_URL se degrada con aviso (registro/identidad quedan inactivos).
let pool: pg.Pool | null = null;

/** Pool para los repositorios (personas, cursos...). null si no hay BD (solo dev). */
export function getPool(): pg.Pool | null {
  return pool;
}

export type AuditEntry = {
  type: string;
  /** Id de conversación para correlación (sin PII). */
  dialogId?: string;
  /** Detalle MINIMIZADO: nunca texto conversacional completo (hallazgo ALTA de la auditoría). */
  detail?: unknown;
};

export async function initDb(): Promise<void> {
  if (!config.databaseUrl) {
    // En producción esto ya es inalcanzable (config zod exige DATABASE_URL); solo dev.
    log.warn('DB: sin DATABASE_URL → identidad/registro inactivos y auditoría solo en logs (solo dev)');
    return;
  }
  try {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      // F12: PGSSL=true VALIDA el certificado del servidor; 'no-verify' queda solo para legado
      // explícito (en F11, Cloud SQL connector reemplaza esto).
      ssl: config.pgSsl === 'true' ? true : config.pgSsl === 'no-verify' ? { rejectUnauthorized: false } : undefined,
      max: config.pgPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Un cliente idle cerrado por el servidor (reinicio/failover de PG) NO debe tumbar el proceso.
    pool.on('error', (err) => log.warn('pg pool: error en cliente idle', { err: String(err) }));
    // Sanity check del esquema: las tablas nacen en migrations/, no aquí.
    await pool.query(`SELECT 1 FROM audit_log LIMIT 0`);
    await pool.query(`SELECT 1 FROM person LIMIT 0`);
    log.info('DB: Postgres conectado y esquema migrado');
  } catch (e) {
    pool = null;
    const msg = `DB: conexión o esquema no disponible — ¿corriste "npm run migrate"? (${String(e)})`;
    if (config.isProd) throw new Error(msg); // fail-fast: sin fuente de verdad no se arranca
    log.error(msg + ' — continuando en modo dev sin BD');
  }
}

export async function dbInsertAudit(e: AuditEntry): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO audit_log (type, dialog_id, detail) VALUES ($1,$2,$3)`,
      [e.type, e.dialogId ?? null, e.detail ? JSON.stringify(e.detail) : null],
    );
  } catch (err) {
    inc('errors:audit');
    log.warn('dbInsertAudit falló', { err: String(err) });
  }
}

export function dbEnabled(): boolean {
  return pool !== null;
}

/** Borra auditoría más antigua que `days` días. Devuelve cuántas filas se borraron. */
export async function dbPurgeOldAudit(days: number): Promise<number> {
  if (!pool || days <= 0) return 0;
  try {
    const r = await pool.query(`DELETE FROM audit_log WHERE ts < now() - ($1 || ' days')::interval`, [String(days)]);
    return r.rowCount ?? 0;
  } catch (e) {
    log.warn('dbPurgeOldAudit falló', { err: String(e) });
    return 0;
  }
}

/**
 * Barrido de retención de auditoría (activo por defecto en ATLAS: AUDIT_RETENTION_DAYS=90).
 * Corre ~1 vez al día, con lock distribuido (once) para que solo una réplica purgue.
 * TODO(F9/F11): migrar el disparo a Cloud Scheduler (los timers in-process no son confiables
 * con scale-to-zero); mientras el servicio tenga min-instances>=1 este barrido sigue operando.
 */
export function startRetentionSweep(): void {
  const days = config.auditRetentionDays;
  if (!pool || days <= 0) {
    log.info('retención de auditoría: desactivada (AUDIT_RETENTION_DAYS<=0 o sin Postgres).');
    return;
  }
  const run = async () => {
    if (!(await once('lock:audit-purge', 23 * 3600))) return; // ~1 vez/día entre réplicas
    const deleted = await dbPurgeOldAudit(days);
    if (deleted) log.info('retención de auditoría: filas borradas', { deleted, days });
  };
  setTimeout(run, 60_000); // primera pasada al minuto del arranque
  setInterval(run, 24 * 3600 * 1000);
  log.info('retención de auditoría: activa', { retencionDias: days });
}
