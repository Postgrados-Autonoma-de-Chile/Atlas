/* "Me llevo una herramienta" como pieza propia, separada del guion de cierre.
 *
 * POR QUÉ: es el momento 5 de la arquitectura didáctica del Plan Nacional —"Recurso visual:
 * entregar una regla, pauta o esquema reutilizable que sintetice el aprendizaje de la
 * microcápsula"—, y hasta ahora no se cargaba como dato: docs/CURRICULO.md lo dejó anotado como
 * pendiente ("hoy vive dentro del guion de cierre"). No es que estuviera mal escrito adentro del
 * cierre —no lo estaba, el cierre nunca lo contuvo—; es que no existía como pieza en absoluto.
 *
 * Es texto FIJO, no narrado: el prompt (src/core/channel.ts) instruye entregarlo tal cual, sin
 * parafraseo, porque acá la palabra exacta importa (una fórmula, una lista de preguntas) de una
 * forma en que el guion de apertura/cierre —que sí admite acortarse— no.
 *
 * NULL en las cápsulas 6 y 8: ninguna de las dos introduce una regla nueva en su documento de
 * producción (la 6 es transferencia a casos distintos; la 8 entrega su propio producto, la ficha,
 * ya implementada en fichaCierre.ts). No es un hueco por completar — es fiel a la fuente.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('lesson', {
    herramienta: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('lesson', ['herramienta']);
};
