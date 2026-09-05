/* Migración inicial de ATLAS (Fase 2): audit_log.
 * A partir de la Fase 3, TODO cambio de esquema entra por una migración de node-pg-migrate
 * (npm run migrate) — el CREATE IF NOT EXISTS inline de src/store/db.ts desaparece entonces.
 * Es idempotente respecto del DDL inline actual (mismas columnas, ifNotExists). */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable(
    'audit_log',
    {
      id: { type: 'bigserial', primaryKey: true },
      ts: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      type: { type: 'text', notNull: true },
      dialog_id: { type: 'text' },
      detail: { type: 'jsonb' },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('audit_log', [{ name: 'ts', sort: 'DESC' }], { name: 'audit_log_ts_idx', ifNotExists: true });
  pgm.createIndex('audit_log', ['type', { name: 'ts', sort: 'DESC' }], { name: 'audit_log_type_ts_idx', ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('audit_log');
};
