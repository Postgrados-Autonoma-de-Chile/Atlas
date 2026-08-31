import { config } from '../config';
import { log } from '../log';
import { audit } from '../obs/audit';
import { getJson } from '../store/kv';
import { wallClock, zonedToUtc, esDiaHabil, dentroDeVentana, type CampaignAgenda } from '../campaign/calendar';
import {
  candidatosContinuarCurso, programarRecordatorio, pendientesDeDespacho, transicionar,
} from '../store/recordatorios';
import { estadoAcademico } from '../store/cursos';
import type { MessagingProvider } from '../messaging/types';

// Motor de recordatorios (Fase 9). Dos etapas idempotentes que dispara Cloud Scheduler (F11) vía
// POST /jobs/recordatorios — nada de setInterval in-process (hallazgo de la auditoría):
//   1) planificar: decide a quién corresponde un recordatorio (inactividad + opt-in + tope) y lo
//      PROGRAMA con clave_dedupe única por ventana temporal (dedupe fail-closed en Postgres).
//   2) despachar: envía los vencidos respetando la ventana horaria hábil de Chile; texto libre si
//      la ventana de servicio de 24h de WhatsApp está abierta (gratis), plantilla utility si no.

/** Agenda educativa del piloto: lunes a sábado, 10:00-20:00 Chile. (Feriados: pendiente lista F11.) */
export const AGENDA_RECORDATORIOS: CampaignAgenda = {
  tz: 'America/Santiago',
  waves: [],
  maxPorDia: 1,
  maxDias: 0,
  maxTotal: 0,
  ventanaHabil: ['10:00', '20:00'],
  diasHabiles: [1, 2, 3, 4, 5, 6],
  feriados: ['2026-09-18', '2026-09-19', '2026-12-25', '2027-01-01'],
};

/** Ventana temporal del dedupe: un recordatorio del mismo tipo como máximo cada N días. */
export function claveDedupe(personId: string, tipo: string, now: Date, cadaDias: number): string {
  const bloque = Math.floor(now.getTime() / (cadaDias * 24 * 3600 * 1000));
  return `${personId}:${tipo}:${bloque}`;
}

/** Próximo instante dentro de la ventana hábil (ahora mismo si ya estamos dentro). */
export function proximaVentanaHabil(now: Date, agenda: CampaignAgenda = AGENDA_RECORDATORIOS): Date {
  const [hIni, mIni] = agenda.ventanaHabil[0].split(':').map(Number);
  for (let d = 0; d < 14; d++) {
    const candidato = d === 0 ? now : new Date(now.getTime() + d * 24 * 3600 * 1000);
    const wc = wallClock(candidato, agenda.tz);
    if (!esDiaHabil(wc.ymd, wc.dow, agenda)) continue;
    if (d === 0 && dentroDeVentana(wc.hh, wc.mm, agenda.ventanaHabil)) return now;
    const apertura = zonedToUtc(wc.y, wc.mo, wc.d, hIni, mIni, agenda.tz);
    if (apertura.getTime() > now.getTime()) return apertura;
  }
  return now; // agenda imposible (>14 días sin día hábil): degradar a "ahora" con aviso del llamador
}

/** ¿La ventana de servicio de 24h de WhatsApp está abierta? (última entrada del estudiante <24h). */
export async function ventana24hAbierta(waId: string): Promise<boolean> {
  const v = await getJson<{ t: number }>(`ult_in:${waId}`);
  return Boolean(v && Date.now() - v.t < 24 * 3600 * 1000);
}

/** Detección de opt-out conversacional ("no me mandes recordatorios", "dejen de escribirme"). */
export function esOptOutRecordatorios(texto: string): boolean {
  const t = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /\b(no\s+(quiero|me\s+(manden|mandes|envien|envies))[^.]*recordatorios?|sin\s+recordatorios?|no\s+enviar\s+recordatorios?|dejen?\s+de\s+(escribirme|molestar(me)?))\b/.test(t);
}

const texto = {
  continuar: (nombre: string | null, curso: string, proxima: string | null) =>
    `¡Hola${nombre ? ` ${nombre}` : ''}! 👋 Te escribo de *ATLAS* (U. Autónoma). Quedó pendiente tu curso *${curso}*${proxima ? ` — la próxima microcápsula es *${proxima}* (5-7 min)` : ''}. ¿Retomamos? Escribe *continuar* cuando quieras 🙂\n\n(Si prefieres no recibir recordatorios, dime "no enviar recordatorios".)`,
};

export type ResumenPlanificacion = { candidatos: number; programados: number; omitidosPorTope: number };

/** Etapa 1: programa recordatorios de continuidad para inactivos con opt-in. Idempotente. */
export async function planificar(now = new Date()): Promise<ResumenPlanificacion> {
  const candidatos = await candidatosContinuarCurso(config.reminderDiasInactividad);
  let programados = 0;
  let omitidosPorTope = 0;
  for (const c of candidatos) {
    if (c.enviadosSinActividad >= config.reminderMaxSinActividad) { omitidosPorTope++; continue; }
    const clave = claveDedupe(c.personId, 'continuar_curso', now, config.reminderDiasInactividad);
    const cuando = proximaVentanaHabil(now);
    if (await programarRecordatorio(c.personId, 'continuar_curso', clave, cuando)) programados++;
  }
  if (candidatos.length) log.info('recordatorios: planificación', { candidatos: candidatos.length, programados, omitidosPorTope });
  return { candidatos: candidatos.length, programados, omitidosPorTope };
}

export type ResumenDespacho = { pendientes: number; enviados: number; reprogramados: number; fallidos: number; omitidos: number };

/** Etapa 2: despacha los recordatorios vencidos. */
export async function despachar(provider: MessagingProvider, now = new Date()): Promise<ResumenDespacho> {
  const pendientes = await pendientesDeDespacho(50);
  const resumen: ResumenDespacho = { pendientes: pendientes.length, enviados: 0, reprogramados: 0, fallidos: 0, omitidos: 0 };

  for (const rm of pendientes) {
    // Fuera de la ventana hábil (p. ej. el job corrió a las 21:30): re-programar, no molestar.
    const wc = wallClock(now, AGENDA_RECORDATORIOS.tz);
    if (!esDiaHabil(wc.ymd, wc.dow, AGENDA_RECORDATORIOS) || !dentroDeVentana(wc.hh, wc.mm, AGENDA_RECORDATORIOS.ventanaHabil)) {
      await transicionar(rm.id, { programadoPara: proximaVentanaHabil(now) });
      resumen.reprogramados++;
      continue;
    }

    // Contenido con datos REALES del progreso (lookup exacto — nunca inventado).
    const estado = await estadoAcademico(rm.personId);
    const cuerpo = texto.continuar(rm.nombre, estado?.curso?.nombre ?? 'tu curso', estado?.proxima?.titulo ?? null);

    const abierta = await ventana24hAbierta(rm.waId);
    let envio;
    if (abierta) {
      envio = await provider.enviarTexto(rm.waId, cuerpo);
    } else if (config.waTemplateRecordatorio) {
      envio = await provider.enviarPlantilla(rm.waId, config.waTemplateRecordatorio, config.waTemplateLang, [rm.nombre ?? 'estudiante']);
    } else {
      // Sin plantilla aprobada configurada y fuera de ventana: no se puede enviar (regla de Meta).
      await transicionar(rm.id, { estado: 'omitido' });
      resumen.omitidos++;
      log.warn('recordatorios: omitido — fuera de ventana 24h y sin WA_TEMPLATE_RECORDATORIO');
      continue;
    }

    if (envio.ok) {
      await transicionar(rm.id, { estado: 'enviado', enviadoEn: true, waMessageId: envio.messageId ?? null });
      resumen.enviados++;
      void audit({ type: 'recordatorio_enviado', dialogId: rm.waId, detail: { tipo: rm.tipo, canal: abierta ? 'texto' : 'plantilla' } });
    } else if (envio.skipped) {
      await transicionar(rm.id, { estado: 'omitido' });
      resumen.omitidos++;
    } else {
      const intentos = rm.intentos + 1;
      if (intentos >= 3) {
        await transicionar(rm.id, { estado: 'fallido', intentos });
        resumen.fallidos++;
      } else {
        await transicionar(rm.id, { intentos, programadoPara: new Date(now.getTime() + 30 * 60_000) });
        resumen.reprogramados++;
      }
    }
  }
  return resumen;
}
