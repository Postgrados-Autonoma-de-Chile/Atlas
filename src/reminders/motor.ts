import { config } from '../config';
import { log } from '../log';
import { audit } from '../obs/audit';
import { getJson } from '../store/kv';
import { wallClock, zonedToUtc, esDiaHabil, dentroDeVentana, type CampaignAgenda } from '../campaign/calendar';
import {
  candidatosContinuarCurso, candidatosSinInscripcion, candidatosPrimerAviso,
  programarRecordatorio, pendientesDeDespacho,
  reclamarParaEnvio, registrarWamid, devolverAProgramado, reprogramar, marcarEstado,
} from '../store/recordatorios';
import { estadoAcademico, avancePrevioArchivado, cursoActivo, expirarInscripciones } from '../store/cursos';
import { estaCompleta, respondidas } from '../store/caracterizacion';
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

/** Detección de opt-out conversacional ("no me mandes recordatorios", "dejen de escribirme"). */
export function esOptOutRecordatorios(texto: string): boolean {
  const t = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /\b(no\s+(quiero|me\s+(manden|mandes|envien|envies))[^.]*recordatorios?|sin\s+recordatorios?|no\s+enviar\s+recordatorios?|dejen?\s+de\s+(escribirme|molestar(me)?))\b/.test(t);
}

/** Reactivación prometida en el mensaje de opt-out. Evaluar SIEMPRE después de esOptOutRecordatorios
 *  ("no quiero recordatorios" también contiene "quiero recordatorios"). */
export function esOptInRecordatorios(texto: string): boolean {
  const t = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /\b(quiero|activa(r|me)?|reactivar?|enviame|mandame)\s+(los\s+|mis\s+)?recordatorios\b/.test(t);
}

/** Fecha del cupo en el formato en que la lee una persona en Chile. */
function fechaCupo(d: Date | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', timeZone: 'America/Santiago' });
}

const texto = {
  /** Primer aviso, el mismo día y dentro de la ventana gratuita. Breve a propósito: es un empujón,
   *  no una campaña, y llega cuando la persona todavía tiene fresco dónde quedó. */
  primerAviso: (nombre: string | null, proxima: string | null) =>
    `¿Seguimos${nombre ? `, ${nombre}` : ''}? 🙂${proxima ? ` Te quedaba *${proxima}* (5-7 min).` : ''} ` +
    `Escribe *continuar* y la vemos ahora.`,
  /** Quien se registró y no está cursando. El mensaje dice DÓNDE quedó, que es lo que hace que
   *  alguien retome: "sigue tu curso" es ruido; "te faltan 6 preguntas" es una acción. */
  retomar: (nombre: string | null, curso: string, parcial: boolean, previo: boolean) => {
    const hola = `¡Hola${nombre ? ` ${nombre}` : ''}! 👋 Te escribo de *ATLAS* (U. Autónoma).`;
    if (parcial) {
      return `${hola} Dejaste a medias el cuestionario inicial y por eso tu curso no ha empezado. ` +
        `Son alternativas y toma un par de minutos: escribe *cuestionario* y lo terminamos 🙂

` +
        `(Si prefieres no recibir recordatorios, dime "no enviar recordatorios".)`;
    }
    if (previo) {
      return `${hola} El programa se actualizó al plan oficial y ahora es *${curso}*: 8 microcápsulas ` +
        `de 5 a 7 minutos. Tu avance anterior no se traslada, así que partimos de nuevo — escribe ` +
        `*empezar* cuando quieras 🙂

(Si prefieres no recibir recordatorios, dime "no enviar recordatorios".)`;
    }
    return `${hola} Quedaste registrado en *${curso}* y todavía no empiezas. Son 8 microcápsulas de ` +
      `5 a 7 minutos y puedes hacerlas a tu ritmo: escribe *empezar* y partimos 🙂

` +
      `(Si prefieres no recibir recordatorios, dime "no enviar recordatorios".)`;
  },
  continuar: (nombre: string | null, curso: string, proxima: string | null, vence?: string | null) =>
    `¡Hola${nombre ? ` ${nombre}` : ''}! 👋 Te escribo de *ATLAS* (U. Autónoma). Quedó pendiente tu curso *${curso}*${proxima ? ` — la próxima microcápsula es *${proxima}* (5-7 min)` : ''}.` +
    // El plazo también va en el mensaje gratuito: la urgencia es real, y decirla solo en la
    // plantilla dejaría peor informado justo a quien sí está conversando.
    `${vence ? ` Tu cupo vence el *${vence}*.` : ''} ¿Retomamos? Escribe *continuar* cuando quieras 🙂` +
    `\n\n(Si prefieres no recibir recordatorios, dime "no enviar recordatorios".)`,
};

export type ResumenPlanificacion = { candidatos: number; programados: number; omitidosPorTope: number };

/** Etapa 1: programa recordatorios de continuidad para inactivos con opt-in. Idempotente. */
export async function planificar(now = new Date()): Promise<ResumenPlanificacion> {
  let programados = 0;
  let omitidosPorTope = 0;

  // Vencer PRIMERO. Si no, un cupo que expiró hace un minuto todavía figura como activo y recibe
  // un "continúa tu curso" que ya no puede cumplir — y el estudiante descubre el vencimiento
  // intentando seguir, en vez de por el aviso.
  await expirarInscripciones();

  // PRIMERO el aviso gratuito: se planifica antes que el de 7 días para que, cuando ambos
  // apliquen, la persona reciba el que no cuesta.
  const primeros = await candidatosPrimerAviso(config.reminderHorasPrimerAviso);
  for (const c of primeros) {
    const clave = `${c.personId}:primer_aviso:${Math.floor(now.getTime() / (24 * 3600 * 1000))}`;
    if (await programarRecordatorio(c.personId, 'primer_aviso', clave, proximaVentanaHabil(now))) programados++;
  }

  const candidatos = await candidatosContinuarCurso(config.reminderDiasInactividad);
  for (const c of candidatos) {
    if (c.enviadosSinActividad >= config.reminderMaxSinActividad) { omitidosPorTope++; continue; }
    const clave = claveDedupe(c.personId, 'continuar_curso', now, config.reminderDiasInactividad);
    const cuando = proximaVentanaHabil(now);
    if (await programarRecordatorio(c.personId, 'continuar_curso', clave, cuando)) programados++;
  }
  // Segundo segmento: registradas que NO están cursando. En el piloto eran más que las que sí
  // cursaban, y ninguna recibía nada — el motor solo miraba inscripciones activas.
  const sinInscripcion = await candidatosSinInscripcion(config.reminderDiasInactividad);
  for (const c of sinInscripcion) {
    if (c.enviadosSinActividad >= config.reminderMaxSinActividad) { omitidosPorTope++; continue; }
    const clave = claveDedupe(c.personId, 'retomar', now, config.reminderDiasInactividad);
    if (await programarRecordatorio(c.personId, 'retomar', clave, proximaVentanaHabil(now))) programados++;
  }

  const total = primeros.length + candidatos.length + sinInscripcion.length;
  if (total) {
    log.info('recordatorios: planificación', {
      primerAviso: primeros.length, cursando: candidatos.length,
      sinInscripcion: sinInscripcion.length, programados, omitidosPorTope,
    });
  }
  return { candidatos: total, programados, omitidosPorTope };
}

export type ResumenDespacho = { pendientes: number; enviados: number; reprogramados: number; fallidos: number; omitidos: number; cancelados: number };

/** Etapa 2: despacha los recordatorios vencidos (semántica AT-MOST-ONCE: reclamar antes de enviar). */
export async function despachar(provider: MessagingProvider, now = new Date()): Promise<ResumenDespacho> {
  const pendientes = await pendientesDeDespacho(50);
  const resumen: ResumenDespacho = { pendientes: pendientes.length, enviados: 0, reprogramados: 0, fallidos: 0, omitidos: 0, cancelados: 0 };

  for (const rm of pendientes) {
    // Revalidación al momento de enviar (revisión F9.1): si la inscripción ya no está activa
    // (completó/abandonó) o el estudiante ESCRIBIÓ después de la programación (ya volvió), el
    // "quedó pendiente tu curso" sería falso → cancelar; si recae, la planificación lo re-crea.
    const estado = await estadoAcademico(rm.personId);
    const ultIn = await getJson<{ t: number }>(`ult_in:${rm.waId}`);
    const cursando = Boolean(estado?.inscrito && estado.enrollment?.estado === 'activa');

    // Escribió después de que se programó: ya volvió por su cuenta y el recordatorio sobra.
    // Y cada tipo se cancela por la razón OPUESTA: 'continuar_curso' si dejó de estar cursando,
    // 'retomar' si empezó a cursar. Para este último, NO estar inscrito es el motivo del aviso, no
    // una condición de cancelación — invertir esto dejaría el segmento entero sin recibir nada.
    const yaVolvio = Boolean(ultIn && ultIn.t > rm.programadoPara.getTime());
    const yaNoAplica = rm.tipo === 'retomar' ? cursando : !cursando;
    if (yaVolvio || yaNoAplica) {
      await marcarEstado(rm.id, 'cancelado');
      resumen.cancelados++;
      continue;
    }

    // Fuera de la ventana hábil (p. ej. el job corrió a las 21:30): re-programar, no molestar.
    const wc = wallClock(now, AGENDA_RECORDATORIOS.tz);
    if (!esDiaHabil(wc.ymd, wc.dow, AGENDA_RECORDATORIOS) || !dentroDeVentana(wc.hh, wc.mm, AGENDA_RECORDATORIOS.ventanaHabil)) {
      await reprogramar(rm.id, proximaVentanaHabil(now));
      resumen.reprogramados++;
      continue;
    }

    // Canal: texto libre si la ventana de servicio de 24h sigue abierta; plantilla utility si no.
    const abierta = Boolean(ultIn && Date.now() - ultIn.t < 24 * 3600 * 1000);

    // El primer aviso existe PORQUE es gratis. Si la ventana ya se cerró, no se convierte en
    // plantilla: eso lo transformaría en un gasto de CLP 78,49 —Meta clasificó nuestra plantilla de
    // recordatorio como marketing— para hacer lo mismo que el aviso de los 7 días hará después.
    // Se descarta y la cadencia normal sigue su curso.
    if (rm.tipo === 'primer_aviso' && !abierta) {
      await marcarEstado(rm.id, 'omitido');
      resumen.omitidos++;
      continue;
    }

    // La plantilla aprobada describe el estado de una inscripción vigente: nombre, microcápsulas
    // pendientes y fecha de vencimiento. Solo es cierta para quien ESTÁ cursando, así que el
    // segmento 'retomar' —que por definición no lo está— no tiene plantilla que usar y espera a que
    // la persona escriba. Decirle "tu cupo vence el X" a quien no tiene cupo sería falso.
    const pendientes = (estado?.totalLecciones ?? 0) - (estado?.completadas ?? 0);
    const venceTxt = fechaCupo(estado?.enrollment?.venceEn);
    const puedePlantilla = Boolean(
      config.waTemplateRecordatorio && rm.tipo === 'continuar_curso' && pendientes > 0 && venceTxt,
    );
    if (!abierta && !puedePlantilla) {
      await marcarEstado(rm.id, 'omitido');
      resumen.omitidos++;
      log.warn('recordatorios: omitido — fuera de ventana 24h y sin plantilla aplicable', {
        tipo: rm.tipo, hayPlantilla: Boolean(config.waTemplateRecordatorio), pendientes, vence: venceTxt,
      });
      continue;
    }

    // RECLAMAR antes de tocar la red: si otro job la tomó, o el proceso muere tras enviar, no hay
    // segundo envío. Perder un recordatorio ante un fallo raro es aceptable; duplicarlo, no.
    if (!(await reclamarParaEnvio(rm.id))) continue;

    let cuerpo: string;
    if (rm.tipo === 'primer_aviso') {
      cuerpo = texto.primerAviso(rm.nombre, estado!.proxima?.titulo ?? null);
    } else if (rm.tipo === 'retomar') {
      // El estado se recalcula al enviar y no se guarda en la fila: entre que se programó y se
      // despacha la persona pudo terminar el cuestionario, y el mensaje quedaría diciendo algo falso.
      const [completa, hechas, previo, curso] = await Promise.all([
        estaCompleta(rm.personId), respondidas(rm.personId),
        avancePrevioArchivado(rm.personId), cursoActivo(),
      ]);
      cuerpo = texto.retomar(rm.nombre, curso?.nombre ?? 'el curso', hechas > 0 && !completa, Boolean(previo));
    } else {
      cuerpo = texto.continuar(
        rm.nombre, estado!.curso?.nombre ?? 'tu curso', estado!.proxima?.titulo ?? null,
        fechaCupo(estado!.enrollment?.venceEn),
      );
    }
    const envio = abierta
      ? await provider.enviarTexto(rm.waId, cuerpo)
      : await provider.enviarPlantilla(rm.waId, config.waTemplateRecordatorio, config.waTemplateLang,
          [rm.nombre ?? 'estudiante', String(pendientes), venceTxt!]);

    if (envio.ok) {
      await registrarWamid(rm.id, envio.messageId ?? null);
      resumen.enviados++;
      void audit({ type: 'recordatorio_enviado', dialogId: rm.waId, detail: { tipo: rm.tipo, canal: abierta ? 'texto' : 'plantilla' } });
    } else if (envio.skipped) {
      await marcarEstado(rm.id, 'omitido');
      resumen.omitidos++;
    } else {
      const intentos = rm.intentos + 1;
      if (intentos >= 3) {
        await marcarEstado(rm.id, 'fallido');
        resumen.fallidos++;
      } else {
        await devolverAProgramado(rm.id, intentos, new Date(now.getTime() + 30 * 60_000));
        resumen.reprogramados++;
      }
    }
  }
  return resumen;
}
