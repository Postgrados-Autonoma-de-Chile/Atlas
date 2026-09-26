/* Índices para consultar la caracterización a escala de programa.
 *
 * Con 200.000 personas la tabla survey_answer llega a ~2,2 millones de filas (11 respuestas por
 * persona). Las dos consultas del panel tienen que seguir siendo baratas ahí:
 *
 *   1. El AGREGADO por pregunta y alternativa — que es para lo que existe una caracterización:
 *      «orientar la oferta formativa». Sin índice, agrupar por option_id obliga a leer la tabla
 *      entera desde el heap. Con este índice el planificador puede resolverlo con un index-only
 *      scan, que además cabe en caché.
 *
 *   2. El DETALLE por persona, paginado por keyset sobre (caracterizacion_completada_en, id).
 *      Se pagina así y no con OFFSET a propósito: un OFFSET 100000 le pide a Postgres leer y
 *      descartar cien mil filas en cada página, y el costo crece con el número de página. El
 *      keyset lee siempre las 50 que se van a mostrar.
 *
 * El índice de person es PARCIAL: solo interesan quienes completaron el cuestionario, que es una
 * fracción del padrón, y así ocupa una fracción del espacio.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createIndex('survey_answer', ['option_id'], { name: 'survey_answer_option_idx', ifNotExists: true });

  pgm.createIndex('person', [{ name: 'caracterizacion_completada_en', sort: 'DESC' }, { name: 'id', sort: 'DESC' }], {
    name: 'person_caracterizacion_idx',
    where: 'caracterizacion_completada_en IS NOT NULL',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('person', [], { name: 'person_caracterizacion_idx', ifExists: true });
  pgm.dropIndex('survey_answer', [], { name: 'survey_answer_option_idx', ifExists: true });
};
