import { getJson, setJson, kvDel } from '../store/kv';
import { config } from '../config';

// Memoria CONVERSACIONAL por conversación, persistida en KV (Redis o memoria). Es la memoria de
// corto plazo del tutor; la memoria ACADÉMICA (progreso, evaluaciones, horas) vive en Postgres
// (Fases 3-4) y NUNCA depende de este historial. TTL y ventana configurables: 48h por defecto
// (un estudiante retoma al día siguiente; las 6h heredadas eran de un lead de ventas).
const KEY = (dialogId: string) => `mem:${dialogId}`;
const MAX_TURNS = config.memoryMaxTurns;
const TTL_SEC = config.memoryTtlHours * 3600;

export async function getHistory(dialogId: string): Promise<any[]> {
  const raw = (await getJson<any[]>(KEY(dialogId))) ?? [];
  // Autorepara historiales corrompidos por el bug del slice ciego (fix heredado de producción),
  // para no arrastrar el 400 de Anthropic en diálogos guardados antes de corregirlo.
  return trimHistory(raw, MAX_TURNS);
}

export async function setHistory(dialogId: string, messages: any[]): Promise<void> {
  await setJson(KEY(dialogId), trimHistory(messages, MAX_TURNS), TTL_SEC);
}

/** Un mensaje que NO puede abrir la conversación para la API de Anthropic: un turno 'assistant'
 *  (debe empezar en 'user'), o un 'user' que es puro tool_result (continuación de un tool_use
 *  del mensaje anterior, ya recortado). */
function esInicioInvalido(message: any): boolean {
  if (!message) return false;
  if (message.role === 'assistant') return true;
  const content = message.content;
  return Array.isArray(content) && content.length > 0 && content.every((b: any) => b?.type === 'tool_result');
}

/** Recorta a los últimos `maxTurns` mensajes SIN dejar un tool_result huérfano (o un turno
 *  'assistant') al inicio: un slice ciego puede cortar justo entre un tool_use y su tool_result,
 *  y Anthropic rechaza ese historial con 400 (visto en producción). */
function trimHistory(messages: any[], maxTurns: number): any[] {
  let cut = messages.slice(-maxTurns);
  while (cut.length && esInicioInvalido(cut[0])) cut = cut.slice(1);
  return cut;
}

export async function resetHistory(dialogId: string): Promise<void> {
  await kvDel(KEY(dialogId));
}
