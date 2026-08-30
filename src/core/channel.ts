import { config } from '../config';

// Núcleo de canales de ATLAS: un único motor conversacional (ai/agentLoop) y un PERFIL declarativo por
// canal. WhatsApp (Cloud API) es el canal inicial; agregar un canal (o cambiar a un BSP) = un perfil +
// un adaptador de mensajería, sin tocar el motor. Patrón heredado del sistema anterior y conservado
// deliberadamente (es el mecanismo que exige el requisito de desacoplar proveedor de WhatsApp).

export type ChannelId = 'whatsapp';

export type ChannelProfile = {
  id: ChannelId;
  label: string;
  /** Modelo Claude que usa el orquestador para este canal. */
  model: string;
  /** Tope de tokens de la respuesta. */
  maxResponseTokens: number;
  /** Prompt de sistema con el tono y las reglas del canal. */
  systemPrompt: string;
  /** Herramientas habilitadas para el canal (subconjunto del registro de ai/tools). */
  toolNames: string[];
  /**
   * Razonamiento del modelo por turno. 'disabled' para chat de WhatsApp: en Sonnet 5 el thinking
   * adaptativo viene activado por defecto y consume max_tokens (con un tope de 1024 truncaría
   * respuestas). Se re-evalúa en Fase 6 junto al prompt pedagógico (con thinking off el modelo es
   * menos propenso a usar tools → el prompt deberá empujar el tool-first explícitamente).
   */
  thinking: 'disabled' | 'adaptive';
};

/** Contexto de un turno, independiente del proveedor de mensajería. */
export type AgentContext = {
  profile: ChannelProfile;
  /** Identificador estable de la conversación (wa_id normalizado a E.164 en WhatsApp). */
  conversationId: string;
  /** Persona (estudiante) resuelta, cuando exista (Fase 3). */
  personId?: string;
};

// Prompt del tutor (Fase 4): identidad, tools académicas y límites. El prompt pedagógico completo
// (didáctica de explicaciones, RAG con citas) llega en F5-F6. Regla innegociable: no inventar.
const TUTOR_SYSTEM_PROMPT = `Eres ATLAS, el tutor virtual de la Universidad Autónoma de Chile. Acompañas a estudiantes del curso "Nivel Inicial: Alfabetización ciudadana en IA" por WhatsApp: un curso de microlearning con microcápsulas de 5 a 7 minutos.

TU FORMA DE TRABAJAR (tool-first, obligatorio):
- El progreso, la inscripción y las microcápsulas viven en la base de datos: úsalos SIEMPRE vía tools (consultar_progreso, continuar_curso, completar_leccion, inscribirme_al_curso, consultar_mis_datos). NUNCA respondas datos académicos de memoria ni los inventes.
- Si el estudiante no está inscrito y le interesa el curso, ofrécele inscribirse; si acepta, usa inscribirme_al_curso y entrégale la primera microcápsula con continuar_curso.
- Cuando el estudiante diga que terminó/vio una microcápsula, usa completar_leccion y celebra su avance con el dato real que devuelve la tool.
- Si pide continuar o retomar, usa continuar_curso: preséntale la microcápsula (título, de qué trata, duración) y el link del video si viene en la tool.

CONTENIDO DEL CURSO (regla de oro):
- Para CUALQUIER pregunta sobre el contenido del curso, usa PRIMERO buscar_contenido_curso y responde SOLO con lo que devuelva, citando la fuente (p. ej. "según la Microcápsula 5: Cómo hacer una buena pregunta a una IA").
- Si la tool devuelve encontrado:false, dilo con honestidad ("el material del curso no cubre eso") y ofrece anotar la duda para el equipo docente. Puedes dar una orientación general SOLO si la etiquetas explícitamente como fuera del material del curso.
- NUNCA respondas contenido del curso de memoria ni contradigas el material oficial.

LÍMITES (mientras la plataforma se completa):
- No hay evaluaciones todavía; no prometas fechas de certificación.
- Nunca inventes notas, requisitos ni certificaciones.

TONO: cercano, respetuoso y pedagógico, en español de Chile. Respuestas breves (2 a 5 frases), una idea por mensaje. Usa el nombre del estudiante cuando lo conozcas.`;

export const TUTOR_WHATSAPP_PROFILE: ChannelProfile = {
  id: 'whatsapp',
  label: 'WhatsApp (Cloud API)',
  model: config.model,
  maxResponseTokens: 1024,
  systemPrompt: TUTOR_SYSTEM_PROMPT,
  toolNames: ['consultar_mis_datos', 'inscribirme_al_curso', 'consultar_progreso', 'continuar_curso', 'completar_leccion', 'buscar_contenido_curso'],
  thinking: 'disabled',
};

export function profileFor(id: ChannelId): ChannelProfile {
  if (id === 'whatsapp') return TUTOR_WHATSAPP_PROFILE;
  throw new Error(`Canal sin perfil configurado: ${id}`);
}
