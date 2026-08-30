/* Fase 4 — Estructura curricular y progreso.
 * Modelado contra el documento real del curso (contenido/Resumen-Ejecutivo-Nivel-Inicial-IA.pdf):
 * cursos de MICROLEARNING — la lección es una "microcápsula" de 5-7 min y el avance se mide en
 * MINUTOS (no horas académicas). El cierre es una actividad (producto de cierre), y la certificación
 * del nivel es por FINALIZACIÓN (las evaluaciones de F7 son formativas, por microcápsula).
 * Regla de la auditoría: los datos académicos siempre por lookup exacto aquí — nunca por RAG. */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('course', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    codigo: { type: 'text', notNull: true, unique: true },
    nombre: { type: 'text', notNull: true },
    descripcion: { type: 'text' },
    proposito: { type: 'text' },
    estado: { type: 'text', notNull: true, default: 'inactivo', check: "estado IN ('activo','inactivo','archivado')" },
    duracion_min: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('module', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    course_id: { type: 'uuid', notNull: true, references: 'course', onDelete: 'CASCADE' },
    orden: { type: 'integer', notNull: true },
    nombre: { type: 'text', notNull: true },
  });
  pgm.addConstraint('module', 'module_orden_unico', { unique: ['course_id', 'orden'] });

  pgm.createTable('lesson', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    module_id: { type: 'uuid', notNull: true, references: 'module', onDelete: 'CASCADE' },
    orden: { type: 'integer', notNull: true },
    titulo: { type: 'text', notNull: true },
    descripcion: { type: 'text' },
    tipo: { type: 'text', notNull: true, default: 'capsula', check: "tipo IN ('capsula','actividad_cierre')" },
    duracion_min: { type: 'integer', notNull: true, default: 6 },
  });
  pgm.addConstraint('lesson', 'lesson_orden_unico', { unique: ['module_id', 'orden'] });

  // Material de una lección: video (URL), documento, transcripción (fuente del RAG en F5), etc.
  pgm.createTable('content_item', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    lesson_id: { type: 'uuid', notNull: true, references: 'lesson', onDelete: 'CASCADE' },
    tipo: { type: 'text', notNull: true, check: "tipo IN ('video','documento','transcripcion','material')" },
    titulo: { type: 'text' },
    url: { type: 'text' },
    gcs_path: { type: 'text' },
    texto: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('content_item', ['lesson_id']);

  pgm.createTable('enrollment', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    person_id: { type: 'uuid', notNull: true, references: 'person', onDelete: 'CASCADE' },
    course_id: { type: 'uuid', notNull: true, references: 'course', onDelete: 'CASCADE' },
    estado: { type: 'text', notNull: true, default: 'activa', check: "estado IN ('activa','completada','abandonada')" },
    minutos_acumulados: { type: 'integer', notNull: true, default: 0 },
    iniciado_en: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completado_en: { type: 'timestamptz' },
  });
  pgm.addConstraint('enrollment', 'enrollment_unico', { unique: ['person_id', 'course_id'] });
  pgm.createIndex('enrollment', ['person_id']);

  pgm.createTable('lesson_progress', {
    id: 'bigserial',
    enrollment_id: { type: 'uuid', notNull: true, references: 'enrollment', onDelete: 'CASCADE' },
    lesson_id: { type: 'uuid', notNull: true, references: 'lesson', onDelete: 'CASCADE' },
    estado: { type: 'text', notNull: true, check: "estado IN ('entregada','completada')" },
    entregado_en: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completado_en: { type: 'timestamptz' },
  });
  pgm.addConstraint('lesson_progress', 'lesson_progress_pk', { primaryKey: 'id' });
  pgm.addConstraint('lesson_progress', 'lesson_progress_unico', { unique: ['enrollment_id', 'lesson_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('lesson_progress');
  pgm.dropTable('enrollment');
  pgm.dropTable('content_item');
  pgm.dropTable('lesson');
  pgm.dropTable('module');
  pgm.dropTable('course');
};
