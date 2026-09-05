/* Fase 3 — Identidad del estudiante: person, person_identity, consent.
 * Diseño (auditoría §9): la Persona es la identidad LÓGICA (uuid); el teléfono es solo UNA identidad
 * vinculada (tipo wa_id) — nunca la clave primaria (números reciclados no mezclan estudiantes).
 * PII sensible (email, RUT) se guarda CIFRADA en person.*_enc (AES-256-GCM de tokenCrypto) y el
 * lookup/unicidad se hace por hash SHA-256 en person_identity.valor_lookup. */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('person', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    nombre: { type: 'text' },
    apellido: { type: 'text' },
    email_enc: { type: 'text' },
    rut_enc: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('person_identity', {
    id: 'bigserial',
    person_id: { type: 'uuid', notNull: true, references: 'person', onDelete: 'CASCADE' },
    tipo: { type: 'text', notNull: true, check: "tipo IN ('wa_id','email','rut')" },
    /** wa_id: E.164 con '+'. email/rut: hash SHA-256 del valor normalizado (el claro va cifrado en person). */
    valor_lookup: { type: 'text', notNull: true },
    verificado: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('person_identity', 'person_identity_pk', { primaryKey: 'id' });
  pgm.addConstraint('person_identity', 'person_identity_unico', { unique: ['tipo', 'valor_lookup'] });
  pgm.createIndex('person_identity', ['person_id']);

  pgm.createTable('consent', {
    id: 'bigserial',
    person_id: { type: 'uuid', notNull: true, references: 'person', onDelete: 'CASCADE' },
    tipo: { type: 'text', notNull: true, check: "tipo IN ('datos','recordatorios')" },
    version_texto: { type: 'text', notNull: true },
    otorgado: { type: 'boolean', notNull: true },
    ts: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('consent', 'consent_pk', { primaryKey: 'id' });
  pgm.createIndex('consent', ['person_id', 'tipo']);
};

exports.down = (pgm) => {
  pgm.dropTable('consent');
  pgm.dropTable('person_identity');
  pgm.dropTable('person');
};
