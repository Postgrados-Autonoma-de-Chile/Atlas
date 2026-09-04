/* Alineación con el plan curricular oficial del Nivel Inicial.
 *
 * FUENTE: "Material Curricular_ PLAN _Alfabetización Ciudadana en Inteligencia Artificial_"
 *   · Nivel 1 IA - Plan Nacional (Ajustado).docx
 *   · Microcapsula 01..08 .docx
 *   · Cuestionario de Caracterización (Ajustado).docx
 *
 * El currículo NO se escribe aquí: vive en curriculo/nivel1.json y lo carga
 * scripts/cargar-curriculo.mjs. Esta migración solo abre el esquema para poder
 * representarlo, de modo que un cambio del material no exija una migración nueva.
 *
 * Se REUTILIZAN las tablas de evaluación existentes (quiz/question/question_option/
 * quiz_attempt/attempt_answer) en vez de crear un sistema paralelo: la estructura
 * "una actividad por lección, con ítems y respuestas registradas" ya era la correcta.
 * Lo que cambia es su semántica curricular — pasa de ser un quiz con nota a ser el
 * momento "Lo intento" que el plan exige en cada microcápsula.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── Curso: propósito formativo, competencia y resultados del plan ──────────
  pgm.addColumns('course', {
    competencia: { type: 'text' },
    resultados_generales: { type: 'jsonb' },
    /** El plan indica certificación por finalización o participación, sin evaluación formal. */
    certificacion: { type: 'text', notNull: true, default: 'finalizacion',
      check: "certificacion IN ('finalizacion','participacion','evaluacion')" },
    producto_cierre: { type: 'text' },
    /** Versión del material curricular con que se cargó, para trazabilidad. */
    version_curriculo: { type: 'text' },
  });

  // ── Microcápsula: los campos de su ficha de diseño ─────────────────────────
  pgm.addColumns('lesson', {
    /** Paso de la ruta metodológica DEFINO → PREGUNTO → ORGANIZO → VERIFICO → DECIDO.
     *  ENTRADA es la cápsula 1 (presenta la ruta), APLICO la 6 (integra cuatro pasos) e
     *  INTEGRO la 8 (aplica la ruta completa). El plan exige que la ruta permanezca
     *  visible durante todo el recorrido. */
    paso_ruta: { type: 'text',
      check: "paso_ruta IS NULL OR paso_ruta IN ('ENTRADA','DEFINO','PREGUNTO','ORGANIZO','VERIFICO','APLICO','DECIDO','INTEGRO')" },
    proposito: { type: 'text' },
    pregunta_movilizadora: { type: 'text' },
    producto_evidencia: { type: 'text' },
    resultados_observables: { type: 'jsonb' },
    /** Guion del Anfitrión. El plan le asigna presencia SOLO al inicio y al cierre de
     *  cada microcápsula: humaniza el recorrido sin asumir el rol de profesor. En
     *  WhatsApp el video no existe, pero el texto del guion sí se entrega. */
    guion_apertura: { type: 'text' },
    guion_cierre: { type: 'text' },
    /** Documento .docx del que provino, para auditar la implementación. */
    fuente_curricular: { type: 'text' },
  });
  pgm.createIndex('lesson', ['paso_ruta']);

  // ── La actividad "Lo intento" de cada microcápsula ─────────────────────────
  pgm.addColumns('quiz', {
    /** Forma de la interacción, deducida de la consigna del documento:
     *   seleccion_unica     — una opción es la mejor (cápsulas 1 y 3)
     *   clasificacion       — cada ítem va a una categoría (2, 4, 5 y 7)
     *   seleccion_multiple  — elegir varias, ninguna incorrecta (6)
     *   eleccion            — elegir modalidad, ambas válidas (8) */
    tipo_interaccion: { type: 'text', notNull: true, default: 'seleccion_unica',
      check: "tipo_interaccion IN ('seleccion_unica','clasificacion','seleccion_multiple','eleccion')" },
    /** Consigna textual del documento: lo que se le pide al participante. */
    consigna: { type: 'text' },
    /** Retroalimentación del documento. El plan pide explicar el CRITERIO, no solo
     *  indicar correcto o incorrecto: se entrega al cerrar la actividad. */
    retroalimentacion: { type: 'text' },
    /** Cuántos ítems hay que responder para dar la actividad por realizada. */
    minimo_requerido: { type: 'integer', notNull: true, default: 1 },
  });

  // Los tipos de ítem se amplían: la clasificación y la elección de modalidad no
  // existían cuando esto era solo un quiz de selección múltiple y verdadero/falso.
  pgm.dropConstraint('question', 'question_tipo_check', { ifExists: true });
  pgm.sql(`ALTER TABLE question DROP CONSTRAINT IF EXISTS question_tipo_check`);
  pgm.sql(`ALTER TABLE question ADD CONSTRAINT question_tipo_check
           CHECK (tipo IN ('seleccion_multiple','verdadero_falso','clasificacion','eleccion','abierta'))`);

  pgm.addColumns('question', {
    /** Hay ítems SIN respuesta correcta por diseño curricular: la cápsula 6 pide
     *  elegir al menos dos casos de interés y la 8 elegir entre trabajar un problema
     *  propio o uno preparado — el documento dice explícitamente que ambas son
     *  válidas. Marcarlas como "correctas" falsearía la retroalimentación; con esta
     *  bandera el flujo acusa recibo y entrega el criterio, sin calificar. */
    sin_respuesta_correcta: { type: 'boolean', notNull: true, default: false },
    /** En una clasificación, el ítem que se está ubicando (las opciones son las
     *  categorías). Permite reconstruir el enunciado sin repetirlo en cada opción. */
    item_texto: { type: 'text' },
  });

  // ── Cuestionario de caracterización ───────────────────────────────────────
  // Catálogo en tablas, no en código: el plan puede ajustar preguntas u opciones sin
  // tocar la lógica del bot.
  pgm.createTable('survey_question', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    /** Código estable ('edad', 'region', ...). Sobrevive a un reordenamiento. */
    codigo: { type: 'text', notNull: true, unique: true },
    orden: { type: 'integer', notNull: true, unique: true },
    seccion: { type: 'text' },
    enunciado: { type: 'text', notNull: true },
    estado: { type: 'text', notNull: true, default: 'activo', check: "estado IN ('activo','inactivo')" },
  });

  pgm.createTable('survey_option', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    question_id: { type: 'uuid', notNull: true, references: 'survey_question', onDelete: 'CASCADE' },
    orden: { type: 'integer', notNull: true },
    texto: { type: 'text', notNull: true },
  });
  pgm.addConstraint('survey_option', 'survey_option_orden_unico', { unique: ['question_id', 'orden'] });

  pgm.createTable('survey_answer', {
    id: 'bigserial',
    person_id: { type: 'uuid', notNull: true, references: 'person', onDelete: 'CASCADE' },
    question_id: { type: 'uuid', notNull: true, references: 'survey_question', onDelete: 'CASCADE' },
    option_id: { type: 'uuid', notNull: true, references: 'survey_option', onDelete: 'CASCADE' },
    respondido_en: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('survey_answer', 'survey_answer_pk', { primaryKey: 'id' });
  pgm.addConstraint('survey_answer', 'survey_answer_unico', { unique: ['person_id', 'question_id'] });

  // Marca de completitud en la persona: el bot debe exigir la caracterización antes
  // de iniciar la ruta, y preguntarlo con un COUNT en cada turno sería caro.
  pgm.addColumns('person', {
    caracterizacion_completada_en: { type: 'timestamptz' },
  });

  // ── Producto de cierre: la ficha de resolución de problema ────────────────
  // El plan la define como evidencia de aplicación de la ruta completa, sin nota.
  // Cinco campos exactos, en el orden en que el documento los enumera.
  pgm.createTable('ficha_cierre', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    enrollment_id: { type: 'uuid', notNull: true, references: 'enrollment', onDelete: 'CASCADE', unique: true },
    /** 'propia' o 'caso_preparado': la cápsula 8 deja elegir, y ambas son válidas. */
    modalidad: { type: 'text', check: "modalidad IS NULL OR modalidad IN ('propia','caso_preparado')" },
    problema: { type: 'text' },
    pregunta_formulada: { type: 'text' },
    respuesta_obtenida: { type: 'text' },
    verificacion: { type: 'text' },
    decision: { type: 'text' },
    completado_en: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ── Nota personal del estudiante ──────────────────────────────────────────
  // La cápsula 2 ofrece un campo OPCIONAL para redactar una necesidad propia, y su
  // documento pide que pueda recuperarse en la cápsula 8. Sin persistirla, esa
  // continuidad se pierde.
  pgm.createTable('nota_estudiante', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    enrollment_id: { type: 'uuid', notNull: true, references: 'enrollment', onDelete: 'CASCADE' },
    lesson_id: { type: 'uuid', notNull: true, references: 'lesson', onDelete: 'CASCADE' },
    texto: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('nota_estudiante', 'nota_estudiante_unica', { unique: ['enrollment_id', 'lesson_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('nota_estudiante');
  pgm.dropTable('ficha_cierre');
  pgm.dropColumns('person', ['caracterizacion_completada_en']);
  pgm.dropTable('survey_answer');
  pgm.dropTable('survey_option');
  pgm.dropTable('survey_question');
  pgm.dropColumns('question', ['sin_respuesta_correcta', 'item_texto']);
  pgm.sql(`ALTER TABLE question DROP CONSTRAINT IF EXISTS question_tipo_check`);
  pgm.sql(`ALTER TABLE question ADD CONSTRAINT question_tipo_check
           CHECK (tipo IN ('seleccion_multiple','verdadero_falso'))`);
  pgm.dropColumns('quiz', ['tipo_interaccion', 'consigna', 'retroalimentacion', 'minimo_requerido']);
  pgm.dropIndex('lesson', ['paso_ruta']);
  pgm.dropColumns('lesson', ['paso_ruta', 'proposito', 'pregunta_movilizadora', 'producto_evidencia',
    'resultados_observables', 'guion_apertura', 'guion_cierre', 'fuente_curricular']);
  pgm.dropColumns('course', ['competencia', 'resultados_generales', 'certificacion', 'producto_cierre',
    'version_curriculo']);
};
