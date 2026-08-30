// Registro único de herramientas del tutor, en el formato de la Anthropic Messages API.
// El motor (agentLoop) filtra por profile.toolNames, así que cada canal habilita su subconjunto.
// Pendientes por fase: buscar_contenido_curso (F5, RAG), iniciar/responder evaluación (F7).

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const SIN_PARAMETROS = { type: 'object', properties: {}, additionalProperties: false };

export const tools: ToolDef[] = [
  {
    name: 'consultar_mis_datos',
    description:
      'Devuelve los datos de registro del estudiante actual: nombre, apellido, correo (enmascarado) y si el correo está verificado. Úsala cuando el estudiante pregunte qué datos suyos tiene ATLAS o quiera confirmar su registro. Si no está registrado, lo indica.',
    input_schema: SIN_PARAMETROS,
  },
  {
    name: 'inscribirme_al_curso',
    description:
      'Inscribe al estudiante en el curso disponible. Úsala cuando el estudiante acepte inscribirse o pida partir el curso y aún no esté inscrito. Devuelve el estado resultante con la primera microcápsula.',
    input_schema: SIN_PARAMETROS,
  },
  {
    name: 'consultar_progreso',
    description:
      'Devuelve el progreso académico REAL del estudiante en su curso: microcápsulas completadas, minutos acumulados y cuál viene ahora. Úsala SIEMPRE que el estudiante pregunte por su avance, cuánto le falta o dónde quedó — nunca respondas el progreso de memoria.',
    input_schema: SIN_PARAMETROS,
  },
  {
    name: 'continuar_curso',
    description:
      'Entrega la microcápsula ACTUAL del curso (título, descripción, duración y link al video/material si existe) y la deja registrada como entregada. Úsala cuando el estudiante quiera continuar, retomar o empezar su curso ya inscrito.',
    input_schema: SIN_PARAMETROS,
  },
  {
    name: 'completar_leccion',
    description:
      'Marca como COMPLETADA la microcápsula actual y acumula sus minutos. Úsala solo cuando el estudiante confirme que ya vio/terminó la microcápsula entregada. Devuelve el nuevo avance y la siguiente microcápsula (o el fin del curso).',
    input_schema: SIN_PARAMETROS,
  },
  {
    name: 'buscar_contenido_curso',
    description:
      'Busca en el MATERIAL OFICIAL del curso (transcripciones y descripciones de las microcápsulas) los fragmentos relevantes para una pregunta de contenido. Úsala SIEMPRE que el estudiante pregunte sobre el contenido del curso, antes de responder. Devuelve fragmentos con su fuente (microcápsula de origen) para citar. Si devuelve encontrado:false, el material no cubre la pregunta: dilo honestamente, nunca inventes.',
    input_schema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'La pregunta o tema a buscar, reformulada de forma clara y autocontenida.' },
      },
      required: ['consulta'],
      additionalProperties: false,
    },
  },
];
