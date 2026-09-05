import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

// Único punto de instanciación del SDK de Anthropic (0.122+). Sigue sin existir una capa de
// abstracción de proveedor completa (decisión #2 de la auditoría: interfaz ligera pendiente);
// hoy el único consumidor de la forma nativa del SDK es agentLoop.ts, así que el costo de un
// eventual cambio de proveedor está acotado a ese archivo y a este.
export const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
  timeout: config.anthropicTimeoutMs, // un turno de chat no debe colgar ~10 min
  maxRetries: config.anthropicMaxRetries,
});

export const REASONER = config.model; // claude-sonnet-5
export const CLASSIFIER = config.classifierModel; // claude-haiku-4-5
