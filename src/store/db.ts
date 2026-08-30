import pg from 'pg';
import { config } from '../config';
import { log } from '../log';
import { once } from './kv';
import { inc } from '../obs/metrics';

// Auditoría persistente en Postgres. En Fase 1 esta capa queda reducida a audit_log + retención;
// el esquema académico de ATLAS (person, course, enrollment, quiz_attempt, ...) llega en las
// Fases 3-4 con un framework de migraciones versionadas (el DDL inline de abajo desaparece entonces)
// y con política fail-fast: cuando Postgres sea la fuente de verdad del progreso, un fallo de BD
// debe detener el arranque, no degradar en silencio.
let pool: pg.Pool | null = null;

export type AuditEntry = {
  type: string;
  /** Id de conversación para correlación (sin PII). */
  dialogId?: string;
  /** Detalle MINIMIZADO: nunca texto conversacional completo (hallazgo ALTA de la auditoría). */
  detail?: unknown;
};

export async function initDb(): Promise<void> {
  if (!config.databaseUrl) {
    log.info('DB: sin DATABASE_URL → auditoría solo en logs');
    return;
  }
  try {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      // TODO(F11): reemplazar por Cloud SQL connector / CA verificada (no aceptar cualquier cert).
      ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Un cliente idle cerrado por el servidor (reinicio/failover de PG) NO debe tumbar el proceso.
    pool.on('error', (err) => log.warn('pg pool: error en cliente idle', { err: String(err) }));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        type TEXT NOT NULL,
        dialog_id TEXT,
        detail JSONB
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_type_ts_idx ON audit_log (type, ts DESC);`);
    log.info('DB: Postgres conectado, tabla audit_log lista');
  } catch (e) {
    log.error('DB: init falló, auditoría solo en logs', { err: String(e) });
    pool = null;
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
