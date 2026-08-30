import type { AgentContext } from '../core/channel';
import { buscarPersonaPorWaId } from '../store/personas';
import { log } from '../log';

// Ejecutor de herramientas del canal de chat. Patrón heredado y conservado:
//   - switch por nombre, con validación de inputs ANTES de cualquier efecto;
//   - try/catch global que devuelve { ok:false, error } sin romper el bucle del agente.

/** Enmascara un email para mostrarlo en chat sin exponerlo completo (r***o@uautonoma.cl). */
function enmascararEmail(email: string): string {
  const [user, dominio] = email.split('@');
  if (!dominio) return '***';
  const visible = user.length <= 2 ? user[0] ?? '*' : `${user[0]}***${user[user.length - 1]}`;
  return `${visible}@${dominio}`;
}

export async function executeTool(name: string, _input: unknown, ctx?: AgentContext): Promise<unknown> {
  try {
    switch (name) {
      case 'consultar_mis_datos': {
        const waId = ctx?.conversationId ?? '';
        const persona = waId ? await buscarPersonaPorWaId(waId) : null;
        if (!persona) return { ok: true, registrado: false };
        return {
          ok: true,
          registrado: true,
          nombre: persona.nombre,
          apellido: persona.apellido,
          email: persona.email ? enmascararEmail(persona.email) : null,
          emailVerificado: persona.emailVerificado,
        };
      }
      default:
        log.warn('executeTool: tool no implementada', { name });
        return { ok: false, error: `tool_no_implementada:${name}` };
    }
  } catch (e) {
    log.error('executeTool: error', { name, err: String(e) });
    return { ok: false, error: String(e) };
  }
}
