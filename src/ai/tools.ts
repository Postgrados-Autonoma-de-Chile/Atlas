// Registro único de herramientas del tutor, en el formato de la Anthropic Messages API.
// El motor (agentLoop) filtra por profile.toolNames, así que cada canal habilita su subconjunto.
//
// Fase 1: registro VACÍO. Las tools educativas llegan con sus fases:
//   - registrar_estudiante / actualizar_identidad (Fase 3)
//   - consultar_progreso / entregar_leccion (Fase 4)
//   - buscar_contenido_curso — RAG con citas (Fase 5)
//   - iniciar_evaluacion / responder_evaluacion (Fase 7)

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export const tools: ToolDef[] = [];
