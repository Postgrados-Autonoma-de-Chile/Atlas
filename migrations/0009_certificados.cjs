/* Fase 8 — Certificación.
 * FSM: elegible → datos_pendientes → emitido → enviado. La fila nace 'elegible' en la MISMA
 * transacción que completa el curso (cursos.completarLeccionActual): la elegibilidad es un hecho
 * persistido, no un estado en memoria. El folio sale de una secuencia (único y auditable).
 * Diseño desacoplado (§15): emitir/enviar son funciones con interfaz clara — integrar el sistema
 * institucional de certificados después significa reemplazar esa implementación, no el flujo. */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createSequence('certificate_folio_seq', { start: 1 });

  pgm.createTable('certificate', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    enrollment_id: { type: 'uuid', notNull: true, references: 'enrollment', onDelete: 'CASCADE', unique: true },
    person_id: { type: 'uuid', notNull: true, references: 'person', onDelete: 'CASCADE' },
    estado: {
      type: 'text', notNull: true, default: 'elegible',
      check: "estado IN ('elegible','datos_pendientes','emitido','enviado')",
    },
    folio: { type: 'text', unique: true },
    emitido_en: { type: 'timestamptz' },
    enviado_en: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('certificate', ['person_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('certificate');
  pgm.dropSequence('certificate_folio_seq');
};
