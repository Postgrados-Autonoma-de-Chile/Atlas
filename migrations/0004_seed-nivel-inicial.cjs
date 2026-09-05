/* Fase 4 — Seed del curso real: "Nivel Inicial — Alfabetización ciudadana en IA".
 * Fuente: contenido/Resumen-Ejecutivo-Nivel-Inicial-IA.pdf (Postgrados UAutónoma).
 * Las TRES propuestas curriculares del documento se siembran como cursos; la Propuesta 1
 * ("IA en la vida cotidiana") queda ACTIVA — el propio documento la recomienda para
 * sensibilización masiva — y las otras dos quedan inactivas a la espera de decisión.
 * Cada curso: 1 módulo de microcápsulas → 8 lecciones de ~6 min + actividad de cierre (10 min) = 58 min.
 * UUIDs fijos → seed idempotente (ON CONFLICT DO NOTHING) y estable entre entornos.
 * Los content_item (videos/transcripciones) se cargan cuando exista el material (F5). */

const CURSOS = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    moduloId: 'd0000000-0000-4000-8000-000000000001',
    codigo: 'NIVEL-INICIAL-P1',
    nombre: 'IA en la vida cotidiana',
    estado: 'activo',
    descripcion:
      'Reconocer la presencia de la inteligencia artificial en la vida cotidiana, comprendiendo sus usos básicos, beneficios, límites y principales cuidados.',
    proposito:
      'Alfabetización básica en IA para la ciudadanía mediante microcápsulas breves: qué es la IA, usos cotidianos, riesgos básicos y uso responsable de la información.',
    lecciones: [
      ['¿Qué es la inteligencia artificial?', 'Explicación simple y accesible de la IA: automatización, aprendizaje a partir de datos y generación de respuestas o contenidos.'],
      ['IA en el celular, redes sociales y aplicaciones', 'Ejemplos cotidianos: recomendaciones de contenido, mapas, filtros, asistentes de voz, streaming, redes sociales y apps.'],
      ['Asistentes conversacionales: qué hacen y qué no hacen', 'Qué son herramientas como ChatGPT u otros asistentes, qué tareas apoyan y cuáles son sus límites.'],
      ['Usos cotidianos de la IA', 'Ejemplos prácticos: organizar tareas, redactar mensajes, resumir información, traducir, planificar y generar ideas.'],
      ['Cómo hacer una buena pregunta a una IA', 'Formular instrucciones claras: entregar contexto, indicar el objetivo y pedir respuestas en formatos simples.'],
      ['Errores, sesgos y respuestas falsas', 'Riesgos básicos: información incorrecta, respuestas incompletas, sesgos y afirmaciones que parecen confiables pero no lo son.'],
      ['Datos personales y uso responsable', 'Qué información no compartir con herramientas de IA: datos personales, contraseñas, información sensible o privada.'],
      ['Actividad de cierre: IA para una situación cotidiana', 'Aplicar lo aprendido a una situación simple: organizar una tarea, redactar un mensaje o resolver una necesidad diaria.'],
    ],
    cierre: ['Producto de cierre: checklist de uso responsable', 'Checklist personal: al menos tres usos posibles de la IA y tres cuidados básicos antes de utilizarla.'],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    moduloId: 'd0000000-0000-4000-8000-000000000002',
    codigo: 'NIVEL-INICIAL-P2',
    nombre: 'IA para resolver problemas diarios',
    estado: 'inactivo',
    descripcion:
      'Utilizar orientaciones básicas de IA para buscar, organizar y analizar información que apoye la resolución de problemas cotidianos.',
    proposito:
      'Uso de la IA como apoyo para enfrentar problemas simples: comprender una situación, comparar alternativas y tomar decisiones informadas.',
    lecciones: [
      ['IA como apoyo para resolver problemas cotidianos', 'La IA como herramienta para ordenar ideas, explorar alternativas, redactar consultas, comparar información o planificar.'],
      ['Cómo describir un problema de manera clara', 'Formular una situación de forma simple: qué ocurre, a quién afecta, qué se necesita resolver y qué información ya se tiene.'],
      ['Cómo pedir información útil a una IA', 'Transformar un problema en una pregunta o instrucción clara; ejemplos de solicitudes simples y mejoradas.'],
      ['Cómo comparar alternativas y organizar respuestas', 'Pedir a la IA listas, tablas, ventajas/desventajas, pasos o criterios de comparación.'],
      ['Cómo verificar si la información es confiable', 'Contrastar respuestas, revisar fuentes, detectar información dudosa y no decidir solo con una respuesta automática.'],
      ['Ejemplos prácticos de uso diario', 'Casos simples: trámites, compras, planificación familiar, estudio, trabajo, salud preventiva e información comunitaria.'],
      ['Límites de la IA en la toma de decisiones', 'Cuándo la IA puede ayudar y cuándo consultar fuentes oficiales, especialistas, instituciones o personas responsables.'],
      ['Actividad de cierre: resolver un problema personal o familiar', 'Secuencia simple: describir un problema, pedir apoyo a la IA, revisar la respuesta y definir próximos pasos.'],
    ],
    cierre: ['Producto de cierre: ficha de resolución de problema', 'Ficha breve: problema identificado, pregunta formulada, respuesta obtenida, verificación básica y decisión o acción posible.'],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    moduloId: 'd0000000-0000-4000-8000-000000000003',
    codigo: 'NIVEL-INICIAL-P3',
    nombre: 'IA, ciudadanía digital y uso responsable',
    estado: 'inactivo',
    descripcion:
      'Comprender la importancia de la IA para la ciudadanía, reconociendo oportunidades, riesgos y buenas prácticas para su uso responsable.',
    proposito:
      'Abordar la IA desde la ciudadanía digital: efectos en la información, la privacidad y la participación, con criterios básicos de uso responsable.',
    lecciones: [
      ['¿Por qué la IA es importante para la ciudadanía?', 'La IA influye en el acceso a información, servicios, trabajo, educación, comunicación y toma de decisiones.'],
      ['IA, información y participación ciudadana', 'Cómo la IA apoya la búsqueda de información, la comprensión de temas públicos y la participación comunitaria.'],
      ['IA y datos personales', 'Proteger datos personales al interactuar con herramientas digitales; no compartir información sensible o privada.'],
      ['Desinformación, sesgos y errores', 'Cómo la IA puede reproducir errores, entregar información imprecisa o reforzar sesgos; actitud crítica.'],
      ['Cómo contrastar información antes de usarla', 'Verificación simple: fuentes oficiales, comparar respuestas, revisar fechas, buscar evidencia, desconfiar de absolutos.'],
      ['Uso responsable de IA en trabajo, estudio y vida cotidiana', 'Buenas prácticas: no reemplazar el juicio personal, no copiar sin revisión, no vulnerar derechos de otras personas.'],
      ['Buenas prácticas para interactuar con herramientas de IA', 'Preguntar con claridad, revisar respuestas, proteger datos, reconocer límites y usar la IA como apoyo.'],
      ['Actividad de cierre: compromiso de uso responsable de IA', 'Elaborar un breve compromiso personal o ciudadano sobre uso seguro, crítico y responsable de la IA.'],
    ],
    cierre: ['Producto de cierre: pauta ciudadana de uso responsable', 'Pauta con buenas prácticas, riesgos a evitar y criterios básicos para verificar información antes de usarla.'],
  },
];

exports.shorthands = undefined;

exports.up = (pgm) => {
  const esc = (s) => String(s).replace(/'/g, "''");
  for (const c of CURSOS) {
    pgm.sql(
      `INSERT INTO course (id, codigo, nombre, descripcion, proposito, estado, duracion_min)
       VALUES ('${c.id}', '${c.codigo}', '${esc(c.nombre)}', '${esc(c.descripcion)}', '${esc(c.proposito)}', '${c.estado}', 58)
       ON CONFLICT (codigo) DO NOTHING`,
    );
    pgm.sql(
      `INSERT INTO module (id, course_id, orden, nombre)
       VALUES ('${c.moduloId}', '${c.id}', 1, 'Microcápsulas')
       ON CONFLICT ON CONSTRAINT module_orden_unico DO NOTHING`,
    );
    c.lecciones.forEach(([titulo, descripcion], i) => {
      pgm.sql(
        `INSERT INTO lesson (module_id, orden, titulo, descripcion, tipo, duracion_min)
         VALUES ('${c.moduloId}', ${i + 1}, '${esc(titulo)}', '${esc(descripcion)}', 'capsula', 6)
         ON CONFLICT ON CONSTRAINT lesson_orden_unico DO NOTHING`,
      );
    });
    pgm.sql(
      `INSERT INTO lesson (module_id, orden, titulo, descripcion, tipo, duracion_min)
       VALUES ('${c.moduloId}', 9, '${esc(c.cierre[0])}', '${esc(c.cierre[1])}', 'actividad_cierre', 10)
       ON CONFLICT ON CONSTRAINT lesson_orden_unico DO NOTHING`,
    );
  }
};

exports.down = (pgm) => {
  for (const c of CURSOS) pgm.sql(`DELETE FROM course WHERE codigo = '${c.codigo}'`);
};
