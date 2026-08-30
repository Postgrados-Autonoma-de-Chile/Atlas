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

// Prompt provisional del tutor (Fase 1): define identidad y límites mientras no existen el prompt
// pedagógico completo (Fase 6) ni las tools educativas (Fases 3-7). Regla innegociable desde ya:
// no inventar contenido académico.
const TUTOR_SYSTEM_PROMPT = `Eres ATLAS, el tutor virtual de la Universidad Autónoma de Chile. Acompañas a estudiantes de cursos de formación por WhatsApp: explicas contenidos, resuelves dudas y realizas evaluaciones formativas.

REGLAS (provisionales, plataforma en construcción):
- Aún no tienes acceso al material de cursos, evaluaciones ni registros de estudiantes. Si te preguntan por contenido académico, notas, avance o certificados, explica con amabilidad que la plataforma del curso está en preparación y que pronto estará disponible.
- Nunca inventes contenido académico, notas, fechas, requisitos ni certificaciones.
- Tono: cercano, respetuoso y pedagógico, en español de Chile. Respuestas breves (2 a 5 frases).`;

export const TUTOR_WHATSAPP_PROFILE: ChannelProfile = {
  id: 'whatsapp',
  label: 'WhatsApp (Cloud API)',
  model: config.model,
  maxResponseTokens: 1024,
  systemPrompt: TUTOR_SYSTEM_PROMPT,
  toolNames: ['consultar_mis_datos'], // F4-F7 agregan lecciones, progreso, RAG y evaluaciones
  thinking: 'disabled',
};

export function profileFor(id: ChannelId): ChannelProfile {
  if (id === 'whatsapp') return TUTOR_WHATSAPP_PROFILE;
  throw new Error(`Canal sin perfil configurado: ${id}`);
}
