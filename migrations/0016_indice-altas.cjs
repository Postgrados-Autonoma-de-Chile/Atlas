/* Índice de altas por fecha.
 *
 * POR QUÉ: la vista de dirección dibuja las altas de los últimos 14 días, y esa consulta filtraba
 * `person.created_at` sin índice: con 21 personas da igual, con 200.000 es un recorrido completo de
 * la tabla cada vez que caduca la caché de 2 minutos. El índice lo vuelve un rango.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createIndex('person', [{ name: 'created_at', sort: 'DESC' }], {
    name: 'person_created_at_idx',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('person', [], { name: 'person_created_at_idx', ifExists: true });
};
