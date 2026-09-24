#!/usr/bin/env node
/** Rastro completo de audit_log para UN wa_id, en una ventana de tiempo. Solo lectura.
 *  node scripts/verificar-persona-auditoria.mjs <wa_id> [horas_atras=72] */
import pg from 'pg';
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL.'); process.exit(1); }
const waId = process.argv[2];
const horas = Number(process.argv[3] ?? 72);
if (!waId) { console.error('Uso: verificar-persona-auditoria.mjs <wa_id> [horas_atras]'); process.exit(1); }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query(
  `SELECT ts, type, detail FROM audit_log
    WHERE dialog_id = $1 AND ts > now() - ($2 || ' hours')::interval
    ORDER BY ts ASC`,
  [waId, String(horas)],
);
console.log(`${rows.length} eventos para ${waId} en las últimas ${horas}h:\n`);
for (const r of rows) {
  const hora = new Date(r.ts).toLocaleString('es-CL', { timeZone: 'America/Santiago', hour12: false });
  console.log(`${hora}  ${r.type}  ${r.detail ? JSON.stringify(r.detail) : ''}`);
}
await pool.end();
