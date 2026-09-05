/* Fase 9 — Recordatorios proactivos.
 * FSM: programado → enviado | fallido | cancelado | omitido.
 * clave_dedupe UNIQUE = dedupe FAIL-CLOSED en Postgres (persona+tipo+ventana temporal): aunque el
 * job corra dos veces o Redis parpadee, un estudiante jamás recibe el mismo recordatorio duplicado
 * (hallazgo de la auditoría sobre once() fail-open aplicado a efectos salientes).
 * wa_message_id correlaciona con los statuses del webhook (failed → estado fallido). */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('reminder', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    person_id: { type: 'uuid', notNull: true, references: 'person', onDelete: 'CASCADE' },
    tipo: { type: 'text', notNull: true, check: "tipo IN ('continuar_curso','evaluacion_pendiente','retomar','finalizar_curso')" },
    estado: { type: 'text', notNull: true, default: 'programado', check: "estado IN ('programado','enviado','fallido','cancelado','omitido')" },
    clave_dedupe: { type: 'text', notNull: true, unique: true },
    programado_para: { type: 'timestamptz', notNull: true },
    enviado_en: { type: 'timestamptz' },
    intentos: { type: 'integer', notNull: true, default: 0 },
    wa_message_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('reminder', ['estado', 'programado_para']);
  pgm.createIndex('reminder', ['person_id']);
  pgm.createIndex('reminder', ['wa_message_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('reminder');
};
