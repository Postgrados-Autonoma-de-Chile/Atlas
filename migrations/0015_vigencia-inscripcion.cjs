/* Vigencia de la inscripción: el cupo tiene plazo.
 *
 * POR QUÉ: hasta ahora una inscripción no vencía nunca, así que "tienes microcápsulas pendientes"
 * no tenía ninguna consecuencia detrás. Con un plazo real el mensaje se vuelve cierto, el
 * seguimiento se puede cerrar, y —efecto secundario que importa— el recordatorio pasa a ser el
 * aviso de una obligación con fecha, que es lo único que Meta admite como plantilla `utility`.
 * Inventar esa fecha habría sido engañar al estudiante y a Meta; tenerla de verdad, no.
 *
 * La inscripción vencida NO borra el avance: la persona puede reactivarla y sigue donde quedó.
 * Cerrar la puerta del todo costaría certificados —uno adicional sale CLP 114 al margen— sin
 * ganar nada, porque el cupo no es escaso por una limitación técnica.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('enrollment', {
    /** Fecha de término del cupo. NULL = sin vencimiento (inscripciones anteriores al cambio). */
    vence_en: { type: 'timestamptz' },
  });

  pgm.sql(`ALTER TABLE enrollment DROP CONSTRAINT IF EXISTS enrollment_estado_check`);
  pgm.sql(`ALTER TABLE enrollment ADD CONSTRAINT enrollment_estado_check
           CHECK (estado IN ('activa','completada','abandonada','vencida'))`);

  // Las inscripciones que ya existen reciben su plazo contado desde que empezaron, no desde hoy:
  // darles 30 días nuevos premiaría a quien lleva semanas sin entrar.
  pgm.sql(`UPDATE enrollment SET vence_en = iniciado_en + interval '30 days' WHERE estado = 'activa'`);

  // El barrido de vencimiento busca activas con plazo cumplido: índice parcial, que es una
  // fracción de la tabla y lo único que ese job necesita leer.
  pgm.createIndex('enrollment', ['vence_en'], {
    name: 'enrollment_vence_idx',
    where: "estado = 'activa' AND vence_en IS NOT NULL",
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('enrollment', [], { name: 'enrollment_vence_idx', ifExists: true });
  // Las vencidas vuelven a 'abandonada', que es el estado más cercano del esquema anterior.
  pgm.sql(`UPDATE enrollment SET estado='abandonada' WHERE estado='vencida'`);
  pgm.sql(`ALTER TABLE enrollment DROP CONSTRAINT IF EXISTS enrollment_estado_check`);
  pgm.sql(`ALTER TABLE enrollment ADD CONSTRAINT enrollment_estado_check
           CHECK (estado IN ('activa','completada','abandonada'))`);
  pgm.dropColumns('enrollment', ['vence_en']);
};
