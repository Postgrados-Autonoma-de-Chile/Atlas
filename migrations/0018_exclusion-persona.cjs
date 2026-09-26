/* Exclusión de personas: ATLAS deja de escribirles Y de responderles, sin borrar el registro.
 *
 * Por qué una marca y no un DELETE: borrar no logra el efecto buscado —si la persona vuelve a
 * escribir, ATLAS no la reconoce y le arranca el registro desde cero, o sea le responde igual—, y
 * además destruye el consentimiento, el avance y el respaldo de certificados ya emitidos (un folio
 * verificable sin su persona detrás deja de ser verificable). La marca es reversible: basta ponerla
 * en NULL para que la persona vuelva a ser atendida con su historia intacta. */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('person', {
    excluido_at: { type: 'timestamptz' },
    excluido_motivo: { type: 'text' },
  });

  // El webhook consulta la exclusión en cada mensaje entrante, por wa_id. El índice parcial cubre
  // solo las filas excluidas, que son pocas frente al total.
  pgm.createIndex('person', 'id', {
    name: 'person_excluido_idx',
    where: 'excluido_at IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('person', 'id', { name: 'person_excluido_idx' });
  pgm.dropColumns('person', ['excluido_at', 'excluido_motivo']);
};
