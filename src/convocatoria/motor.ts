import { config } from '../config';
import { log } from '../log';
import { audit } from '../obs/audit';
import { inc } from '../obs/metrics';
import { wallClock, esDiaHabil, dentroDeVentana, type CampaignAgenda } from '../campaign/calendar';
import {
  candidatasParaEnviar, descartarYaRegistradas, reclamarParaEnvio, registrarWamid, marcarFallida,
} from '../store/invitaciones';
import type { MessagingProvider } from '../messaging/types';

// Convocatoria de cohortes: llevar gente HACIA el tutor.
//
// Es la única pieza del sistema que gasta dinero por su cuenta, y a escala de cohorte el monto no es
// trivial: una plantilla de categoría marketing ronda USD 0,025-0,137 según país, así que 10.000
// invitaciones son cientos de dólares. Además está sujeta al tramo de mensajería de Meta, que empieza
// en 2.000 contactos por 24 h para un negocio verificado. Por eso el job viene APAGADO por defecto y
// con cupo por corrida y por día.
//
// LA PALANCA REAL NO ESTÁ ACÁ. Quien llega por el QR (ver qr.ts) escribe primero, y una conversación
// iniciada por el estudiante es gratis y no consume tramo. La estrategia que sale mejor en costo,
// plazo y riesgo de calidad es dejar correr el QR primero y mandar plantillas solo al remanente:
// `descartarYaRegistradas` es lo que materializa ese ahorro antes de gastar.

/** Agenda de la convocatoria: misma ventana educativa que los recordatorios (lunes a sábado). */
export const AGENDA_CONVOCATORIA: CampaignAgenda = {
  tz: 'America/Santiago',
  waves: [],
  maxPorDia: 0,
  maxDias: 0,
  maxTotal: 0,
  ventanaHabil: ['10:00', '20:00'],
  diasHabiles: [1, 2, 3, 4, 5, 6],
  feriados: ['2026-09-18', '2026-09-19', '2026-12-25', '2027-01-01'],
};

/**
 * Parámetros del cuerpo de la plantilla: {{1}} nombre de pila.
 * PURA. Sin nombre usa un saludo genérico — una plantilla con un parámetro vacío la rechaza Meta.
 */
export function parametrosPlantilla(nombre: string | null): string[] {
  const pila = String(nombre ?? '').trim().split(/\s+/)[0];
  return [pila || 'Hola'];
}

export type MotivoOmision = 'desactivada' | 'sin_plantilla' | 'fuera_de_horario' | 'cupo_diario';
export type ResultadoConvocatoria =
  | { corrio: false; motivo: MotivoOmision; detalle?: unknown }
  | { corrio: true; descartadas: number; candidatas: number; enviadas: number; fallidas: number };

/**
 * Una oleada. Idempotente frente a corridas solapadas por el reclamo atómico en Postgres.
 * `enviadasHoy` lo aporta el llamador (lo calcula el store) para no acoplar el motor a la consulta.
 */
export async function correrOleada(
  provider: MessagingProvider,
  enviadasHoy: number,
  now = new Date(),
): Promise<ResultadoConvocatoria> {
  if (!config.convocatoriaActiva) return { corrio: false, motivo: 'desactivada' };
  if (!config.convocatoriaTemplate) return { corrio: false, motivo: 'sin_plantilla' };

  const wc = wallClock(now, AGENDA_CONVOCATORIA.tz);
  if (!esDiaHabil(wc.ymd, wc.dow, AGENDA_CONVOCATORIA) || !dentroDeVentana(wc.hh, wc.mm, AGENDA_CONVOCATORIA.ventanaHabil!)) {
    return { corrio: false, motivo: 'fuera_de_horario', detalle: { hora: `${wc.hh}:${wc.mm}`, fecha: wc.ymd } };
  }

  const restanteHoy = config.convocatoriaMaxPorDia - enviadasHoy;
  if (restanteHoy <= 0) {
    return { corrio: false, motivo: 'cupo_diario', detalle: { enviadasHoy, tope: config.convocatoriaMaxPorDia } };
  }

  // PRIMERO descartar a quien ya llegó por el QR: es plata que no se gasta.
  const descartadas = await descartarYaRegistradas();
  if (descartadas) log.info('convocatoria: descartadas por estar ya registradas', { descartadas });

  const cupo = Math.min(config.convocatoriaMaxPorCorrida, restanteHoy);
  const candidatas = await candidatasParaEnviar(cupo, config.convocatoriaMaxIntentos);

  let enviadas = 0;
  let fallidas = 0;
  for (const c of candidatas) {
    // Reclamo atómico: si otra réplica la tomó, seguimos con la siguiente sin enviar nada.
    if (!(await reclamarParaEnvio(c.id))) continue;
    try {
      const r = await provider.enviarPlantilla(
        c.telefono,
        config.convocatoriaTemplate,
        config.waTemplateLang,
        parametrosPlantilla(c.nombre),
      );
      if (r.ok) {
        await registrarWamid(c.id, r.messageId ?? null);
        enviadas++;
        inc('convocatoria:enviadas');
      } else {
        await marcarFallida(c.id);
        fallidas++;
        inc('convocatoria:fallidas');
        log.warn('convocatoria: envío rechazado', { error: r.error, skipped: r.skipped });
      }
    } catch (e) {
      await marcarFallida(c.id);
      fallidas++;
      inc('convocatoria:fallidas');
      log.error('convocatoria: envío falló', { err: String(e) });
    }
  }

  if (enviadas || fallidas) {
    await audit({ type: 'convocatoria_oleada', detail: { descartadas, candidatas: candidatas.length, enviadas, fallidas } });
  }
  return { corrio: true, descartadas, candidatas: candidatas.length, enviadas, fallidas };
}
