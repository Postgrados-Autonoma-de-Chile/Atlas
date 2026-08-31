/* Convocatoria de cohortes: invitar a gente que TODAVÍA NO existe como Persona.
 *
 * Es la diferencia con `reminder`, que apunta a estudiantes ya registrados y por eso puede tener FK
 * a person. Acá el teléfono es la única identidad disponible, así que va UNIQUE y sin FK.
 *
 * FSM: pendiente → enviada → respondio | fallida | descartada.
 *   - `descartada` es la que ahorra plata: la persona ya llegó por el QR (existe Persona) o pidió no
 *     ser contactada, así que la plantilla NO se envía ni se paga.
 *   - `respondio` la marca el webhook en el primer mensaje entrante de ese número, venga del QR o de
 *     la plantilla. Saca a la persona de la cola aunque todavía no complete el registro.
 *
 * telefono UNIQUE da idempotencia de carga gratis: recargar el mismo listado no duplica ni reenvía. */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('invitation', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    /** E.164 con '+'. La identidad antes de que exista una Persona. */
    telefono: { type: 'text', notNull: true, unique: true },
    /** Opcional: si viene, la plantilla saluda por el nombre de pila. */
    nombre: { type: 'text' },
    /** Identificador de la carga, para poder medir y acotar por tanda. */
    lote: { type: 'text', notNull: true },
    estado: {
      type: 'text',
      notNull: true,
      default: 'pendiente',
      check: "estado IN ('pendiente','enviada','respondio','fallida','descartada')",
    },
    enviada_en: { type: 'timestamptz' },
    respondio_en: { type: 'timestamptz' },
    intentos: { type: 'integer', notNull: true, default: 0 },
    /** Correlaciona con los statuses del webhook (failed → fallida). */
    wa_message_id: { type: 'text' },
    motivo_descarte: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('invitation', ['estado', 'created_at']);
  pgm.createIndex('invitation', ['wa_message_id']);
  pgm.createIndex('invitation', ['lote']);
};

exports.down = (pgm) => {
  pgm.dropTable('invitation');
};
