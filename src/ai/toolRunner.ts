import type { AgentContext } from '../core/channel';
import { buscarPersonaPorWaId } from '../store/personas';
import { inscribir, estadoAcademico, entregarLeccionActual, completarLeccionActual } from '../store/cursos';
import { audit } from '../obs/audit';
import { log } from '../log';

// Ejecutor de herramientas del canal de chat. Patrón heredado y conservado:
//   - switch por nombre, con validación ANTES de cualquier efecto;
//   - try/catch global que devuelve { ok:false, error } sin romper el bucle del agente.
// Los datos académicos SIEMPRE salen de Postgres vía store/cursos — nunca de la memoria del modelo.

/** Enmascara un email para mostrarlo en chat sin exponerlo completo (r***o@uautonoma.cl). */
function enmascararEmail(email: string): string {
  const [user, dominio] = email.split('@');
  if (!dominio) return '***';
  const visible = user.length <= 2 ? user[0] ?? '*' : `${user[0]}***${user[user.length - 1]}`;
  return `${visible}@${dominio}`;
}

const NO_REGISTRADO = { ok: false, error: 'no_registrado', mensaje: 'El estudiante aún no está registrado: invítalo a registrarse escribiendo "quiero registrarme".' };

export async function executeTool(name: string, _input: unknown, ctx?: AgentContext): Promise<unknown> {
  try {
    switch (name) {
      case 'consultar_mis_datos': {
        const persona = ctx?.conversationId ? await buscarPersonaPorWaId(ctx.conversationId) : null;
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

      case 'inscribirme_al_curso': {
        if (!ctx?.personId) return NO_REGISTRADO;
        const estado = await inscribir(ctx.personId);
        if (!estado) return { ok: false, error: 'bd_no_disponible' };
        if (!estado.inscrito) return { ok: false, error: 'sin_curso_activo' };
        void audit({ type: 'inscripcion', dialogId: ctx.conversationId, detail: { curso: estado.curso?.codigo } });
        return { ok: true, curso: estado.curso?.nombre, totalMicrocapsulas: estado.totalLecciones, primera: estado.proxima };
      }

      case 'consultar_progreso': {
        if (!ctx?.personId) return NO_REGISTRADO;
        const estado = await estadoAcademico(ctx.personId);
        if (!estado) return { ok: false, error: 'bd_no_disponible' };
        if (!estado.inscrito) return { ok: true, inscrito: false, mensaje: 'No está inscrito aún; ofrécele inscribirse.' };
        return {
          ok: true,
          inscrito: true,
          curso: estado.curso?.nombre,
          estadoInscripcion: estado.enrollment?.estado,
          completadas: estado.completadas,
          total: estado.totalLecciones,
          minutosAcumulados: estado.enrollment?.minutosAcumulados,
          proxima: estado.proxima ?? null,
        };
      }

      case 'continuar_curso': {
        if (!ctx?.personId) return NO_REGISTRADO;
        const entrega = await entregarLeccionActual(ctx.personId);
        if (!entrega) return { ok: false, error: 'sin_leccion_pendiente', mensaje: 'No hay lección pendiente: o no está inscrito, o ya completó el curso (consulta el progreso).' };
        void audit({ type: 'leccion_entregada', dialogId: ctx?.conversationId, detail: { orden: entrega.leccion.orden } });
        return { ok: true, posicion: entrega.posicion, leccion: entrega.leccion };
      }

      case 'completar_leccion': {
        if (!ctx?.personId) return NO_REGISTRADO;
        const r = await completarLeccionActual(ctx.personId);
        if (!r) return { ok: false, error: 'sin_leccion_pendiente' };
        void audit({
          type: 'leccion_completada',
          dialogId: ctx?.conversationId,
          detail: { orden: r.completada.orden, minutos: r.minutosAcumulados, finCurso: r.cursoCompletado },
        });
        return {
          ok: true,
          completada: r.completada,
          minutosAcumulados: r.minutosAcumulados,
          cursoCompletado: r.cursoCompletado,
          siguiente: r.siguiente ?? null,
          ...(r.cursoCompletado
            ? { mensaje: 'Felicita al estudiante: terminó todas las microcápsulas. La certificación se habilitará pronto (no prometas fechas).' }
            : {}),
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
