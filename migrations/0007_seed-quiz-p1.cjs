/* Fase 7 — Seed del banco de preguntas del curso NIVEL-INICIAL-P1 (IA en la vida cotidiana).
 * 8 mini-quizzes (uno por microcápsula) × 2 preguntas (1 selección múltiple + 1 V/F) = 16 preguntas,
 * derivadas ESTRICTAMENTE de las descripciones oficiales del documento del curso — la explicación
 * docente cita su microcápsula. Idempotente: UUIDs fijos + ON CONFLICT DO NOTHING; el lesson_id se
 * resuelve por (módulo fijo del seed 0004, orden). */

const MODULO_P1 = 'd0000000-0000-4000-8000-000000000001';
const QZ = (n) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const QQ = (n) => `f0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

// [capsula, [enunciadoSM, opciones[4], idxCorrecta(0-3), explicacionSM], [enunciadoVF, esVerdadero, explicacionVF]]
const BANCO = [
  [1,
    ['Según el curso, ¿qué describe mejor a la inteligencia artificial?',
      ['Un robot físico que piensa igual que un humano', 'Sistemas que aprenden a partir de datos y generan respuestas o contenidos', 'Un programa que solo repite lo que se le escribe', 'Una tecnología exclusiva de laboratorios científicos'], 1,
      'La Microcápsula 1 explica la IA sin tecnicismos: automatización, aprendizaje a partir de datos y generación de respuestas o contenidos.'],
    ['La IA solo existe en laboratorios y no se usa en la vida cotidiana.', false,
      'Falso: la Microcápsula 1 (y todo el curso) muestra que la IA ya forma parte de muchas interacciones cotidianas.']],
  [2,
    ['¿Cuál de estos es un ejemplo de IA en tu celular según el curso?',
      ['La linterna del teléfono', 'El botón de encendido', 'Las recomendaciones de contenido en redes sociales y streaming', 'La carcasa protectora'], 2,
      'La Microcápsula 2 muestra la IA en recomendaciones de contenido, mapas, filtros, asistentes de voz, streaming y apps.'],
    ['Los mapas y los asistentes de voz del celular usan inteligencia artificial.', true,
      'Verdadero: la Microcápsula 2 los presenta entre los ejemplos cotidianos de IA.']],
  [3,
    ['Según el curso, ¿qué son los asistentes conversacionales como ChatGPT?',
      ['Personas respondiendo en tiempo real', 'Herramientas que apoyan tareas como redactar o resumir, con límites que hay que conocer', 'Buscadores que siempre dicen la verdad', 'Programas que entienden todo sin equivocarse'], 1,
      'La Microcápsula 3 explica qué tareas pueden apoyar estos asistentes y cuáles son sus principales límites.'],
    ['Un asistente conversacional puede equivocarse en sus respuestas.', true,
      'Verdadero: la Microcápsula 3 enseña que estos asistentes tienen límites y no todo lo que dicen es correcto.']],
  [4,
    ['¿Cuál de estos usos cotidianos de la IA presenta el curso?',
      ['Organizar tareas, redactar mensajes y resumir información', 'Reemplazar todas las decisiones personales', 'Reparar físicamente el teléfono', 'Eliminar la necesidad de aprender'], 0,
      'La Microcápsula 4 muestra ejemplos prácticos: organizar tareas, redactar, resumir, traducir, planificar y generar ideas.'],
    ['La IA puede ayudarte a traducir textos y planificar actividades.', true,
      'Verdadero: son ejemplos prácticos de la Microcápsula 4.']],
  [5,
    ['Según el curso, ¿qué hace buena una pregunta a una IA?',
      ['Escribirla lo más corta posible, sin contexto', 'Usar palabras técnicas complicadas', 'Repetirla muchas veces seguidas', 'Entregar contexto, indicar el objetivo y pedir un formato simple'], 3,
      'La Microcápsula 5 enseña a formular instrucciones claras: contexto + objetivo + formato simple de respuesta.'],
    ['Darle contexto a la IA mejora la calidad de sus respuestas.', true,
      'Verdadero: es la idea central de la Microcápsula 5.']],
  [6,
    ['¿Cuál es un riesgo básico del uso de IA según el curso?',
      ['Que la IA se aburra de responder', 'Respuestas que parecen confiables pero son incorrectas', 'Que la IA cobre por cada respuesta', 'Que la IA borre el teléfono'], 1,
      'La Microcápsula 6 aborda información incorrecta, respuestas incompletas, sesgos y afirmaciones que parecen confiables pero no lo son.'],
    ['Todo lo que responde una IA es verdad.', false,
      'Falso: la Microcápsula 6 enseña que la IA puede entregar información incorrecta o sesgada; hay que verificar.']],
  [7,
    ['Según el curso, ¿qué NO deberías compartir con una herramienta de IA?',
      ['Dudas sobre el contenido del curso', 'Preguntas sobre recetas de cocina', 'Contraseñas y datos personales sensibles', 'Ideas para un regalo'], 2,
      'La Microcápsula 7 orienta a no compartir datos personales, contraseñas ni información sensible o privada.'],
    ['Es seguro compartir tus contraseñas con un asistente de IA.', false,
      'Falso: la Microcápsula 7 lo señala explícitamente como información que NO se comparte.']],
  [8,
    ['La actividad de cierre del curso te invita a…',
      ['Rendir un examen presencial', 'Programar tu propio modelo de IA', 'Memorizar definiciones técnicas', 'Aplicar lo aprendido a una situación cotidiana simple'], 3,
      'La Microcápsula 8 propone aplicar lo aprendido: organizar una tarea, redactar un mensaje o resolver una necesidad diaria.'],
    ['El producto de cierre es un checklist con usos posibles de la IA y cuidados básicos.', true,
      'Verdadero: el producto de cierre pide identificar al menos tres usos y tres cuidados antes de usar la IA.']],
];

exports.shorthands = undefined;

exports.up = (pgm) => {
  const esc = (s) => String(s).replace(/'/g, "''");
  let q = 0;
  for (const [capsula, sm, vf] of BANCO) {
    const quizId = QZ(capsula);
    pgm.sql(
      `INSERT INTO quiz (id, lesson_id, titulo)
       SELECT '${quizId}', l.id, 'Mini-quiz — Microcápsula ${capsula}'
       FROM lesson l WHERE l.module_id='${MODULO_P1}' AND l.orden=${capsula}
       ON CONFLICT (lesson_id) DO NOTHING`,
    );
    // Selección múltiple
    q++;
    const smId = QQ(q);
    pgm.sql(
      `INSERT INTO question (id, quiz_id, orden, tipo, enunciado, explicacion)
       VALUES ('${smId}','${quizId}',1,'seleccion_multiple','${esc(sm[0])}','${esc(sm[3])}')
       ON CONFLICT ON CONSTRAINT question_orden_unico DO NOTHING`,
    );
    sm[1].forEach((texto, i) => {
      pgm.sql(
        `INSERT INTO question_option (question_id, orden, texto, es_correcta)
         VALUES ('${smId}',${i + 1},'${esc(texto)}',${i === sm[2]})
         ON CONFLICT ON CONSTRAINT question_option_orden_unico DO NOTHING`,
      );
    });
    // Verdadero/Falso
    q++;
    const vfId = QQ(q);
    pgm.sql(
      `INSERT INTO question (id, quiz_id, orden, tipo, enunciado, explicacion)
       VALUES ('${vfId}','${quizId}',2,'verdadero_falso','${esc(vf[0])}','${esc(vf[2])}')
       ON CONFLICT ON CONSTRAINT question_orden_unico DO NOTHING`,
    );
    pgm.sql(
      `INSERT INTO question_option (question_id, orden, texto, es_correcta)
       VALUES ('${vfId}',1,'Verdadero',${vf[1] === true}), ('${vfId}',2,'Falso',${vf[1] === false})
       ON CONFLICT ON CONSTRAINT question_option_orden_unico DO NOTHING`,
    );
  }
};

exports.down = (pgm) => {
  for (let c = 1; c <= 8; c++) pgm.sql(`DELETE FROM quiz WHERE id='${QZ(c)}'`);
};
