import type { AgentContext } from '../core/channel';
import { log } from '../log';

// Ejecutor de herramientas del canal de chat. Se conserva el PATRÓN del sistema anterior:
//   - switch por nombre de tool, con validación de inputs ANTES de cualquier efecto;
//   - try/catch global que devuelve { ok:false, error } sin romper el bucle del agente;
//   - efectos salientes (mensajes, escrituras) siempre idempotentes.
//
// Fase 1: no hay tools registradas (ai/tools.ts está vacío), así que cualquier llamada devuelve
// un error controlado. Las ramas reales se implementan en las Fases 3-7.
export async function executeTool(name: string, _input: unknown, _ctx?: AgentContext): Promise<unknown> {
  log.warn('executeTool: tool no implementada', { name });
  return { ok: false, error: `tool_no_implementada:${name}` };
}
