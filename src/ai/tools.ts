// Registro único de herramientas del tutor, en el formato de la Anthropic Messages API.
// El motor (agentLoop) filtra por profile.toolNames, así que cada canal habilita su subconjunto.
// Pendientes por fase: entregar_leccion/consultar_progreso (F4), buscar_contenido_curso (F5),
// iniciar_evaluacion/responder_evaluacion (F7).

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export const tools: ToolDef[] = [
  {
    name: 'consultar_mis_datos',
    description:
      'Devuelve los datos de registro del estudiante actual: nombre, apellido, correo (enmascarado) y si el correo está verificado. Úsala cuando el estudiante pregunte qué datos suyos tiene ATLAS o quiera confirmar su registro. Si no está registrado, lo indica.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
