/* Fase 7 — Evaluaciones formativas (selección múltiple y V/F por microcápsula).
 * Registro completo del requisito §9: pregunta, opciones, respuesta del estudiante, correcta,
 * resultado, explicación enviada, curso/módulo (vía lesson→module→course), fecha, nº de intento y
 * tiempo de respuesta. La explicación DOCENTE vive en question.explicacion — la retroalimentación
 * nace del material oficial, no de la imaginación del modelo. */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('quiz', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    lesson_id: { type: 'uuid', notNull: true, references: 'lesson', onDelete: 'CASCADE', unique: true },
    titulo: { type: 'text', notNull: true },
    estado: { type: 'text', notNull: true, default: 'activo', check: "estado IN ('activo','inactivo')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('question', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    quiz_id: { type: 'uuid', notNull: true, references: 'quiz', onDelete: 'CASCADE' },
    orden: { type: 'integer', notNull: true },
    tipo: { type: 'text', notNull: true, check: "tipo IN ('seleccion_multiple','verdadero_falso')" },
    enunciado: { type: 'text', notNull: true },
    /** Explicación docente: se envía como retroalimentación (correcta o no) citando la microcápsula. */
    explicacion: { type: 'text', notNull: true },
  });
  pgm.addConstraint('question', 'question_orden_unico', { unique: ['quiz_id', 'orden'] });

  pgm.createTable('question_option', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    question_id: { type: 'uuid', notNull: true, references: 'question', onDelete: 'CASCADE' },
    orden: { type: 'integer', notNull: true },
    texto: { type: 'text', notNull: true },
    es_correcta: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('question_option', 'question_option_orden_unico', { unique: ['question_id', 'orden'] });

  pgm.createTable('quiz_attempt', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    enrollment_id: { type: 'uuid', notNull: true, references: 'enrollment', onDelete: 'CASCADE' },
    quiz_id: { type: 'uuid', notNull: true, references: 'quiz', onDelete: 'CASCADE' },
    intento_n: { type: 'integer', notNull: true },
    total: { type: 'integer', notNull: true },
    correctas: { type: 'integer', notNull: true, default: 0 },
    iniciado_en: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finalizado_en: { type: 'timestamptz' },
  });
  pgm.addConstraint('quiz_attempt', 'quiz_attempt_unico', { unique: ['enrollment_id', 'quiz_id', 'intento_n'] });
  pgm.createIndex('quiz_attempt', ['enrollment_id']);

  pgm.createTable('attempt_answer', {
    id: 'bigserial',
    attempt_id: { type: 'uuid', notNull: true, references: 'quiz_attempt', onDelete: 'CASCADE' },
    question_id: { type: 'uuid', notNull: true, references: 'question', onDelete: 'CASCADE' },
    option_id: { type: 'uuid', notNull: true, references: 'question_option', onDelete: 'CASCADE' },
    es_correcta: { type: 'boolean', notNull: true },
    tiempo_respuesta_ms: { type: 'integer' },
    explicacion_enviada: { type: 'text' },
    respondido_en: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('attempt_answer', 'attempt_answer_pk', { primaryKey: 'id' });
  pgm.addConstraint('attempt_answer', 'attempt_answer_unico', { unique: ['attempt_id', 'question_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('attempt_answer');
  pgm.dropTable('quiz_attempt');
  pgm.dropTable('question_option');
  pgm.dropTable('question');
  pgm.dropTable('quiz');
};
