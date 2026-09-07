import { getJson, setJson, kvDel } from '../store/kv';
import { dbEnabled } from '../store/db';
import {
  siguientePregunta, guardarRespuesta, cerrarSiCompleta, respondidas, totalPreguntas,
  type PreguntaCaracterizacion,
} from '../store/caracterizacion';
import { inscribir, cursoActivo } from '../store/cursos';
import { audit } from '../obs/audit';
import type { InboundMessage, MessagingProvider } from '../messaging/types';
import type { Persona } from '../store/personas';

// Flujo DETERMINISTA del cuestionario de caracterización (11 preguntas), primer paso de la
// experiencia según el plan curricular oficial.
//
// FUENTE: "Cuestionario de Caracterización (Ajustado).docx".
//
// Como el registro, la evaluación y la certificación, esto NO pasa por el LLM: son preguntas
// cerradas con opciones fijas, y el parsing de la alternativa elegida debe ser exacto. Delegarlo a
// un modelo solo agregaría costo y una fuente de error.
//
// La ruta curricular queda BLOQUEADA hasta que el cuestionario esté completo — el control está en
// el estado, no en el prompt (ver toolRunner: inscribirme_al_curso y continuar_curso lo verifican).

type EstadoCaracterizacion = {
  questionId: string;
  /** Opciones enviadas, en el orden en que se ofrecieron: mapea la elección a su id. */
  opciones: { id: string; texto: string }[];
  enviadaEn: number;
};

const KEY = (waId: string) => `caracterizacion:${waId}`;
const TTL = 7 * 24 * 3600; // una semana: el plan no exige responder de una sola vez

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const textoDe = (m: InboundMessage) =>
  (m.type === 'text' ? m.text ?? '' : m.type === 'interactive' ? m.interactiveReplyTitle ?? '' : '').trim();

const RE_PAUSA = /\b(salir|pausa(r)?|despues|luego|mas tarde)\b/;
const RE_INICIAR = /\b(cuestionario|caracterizacion|encuesta|empezar|comenzar|partir|inscribirme|curso)\b/;

/**
 * Introducción TEXTUAL del cuestionario oficial. Se transcribe literal —incluida la declaración
 * de finalidad y el "no existen respuestas correctas ni incorrectas"— porque es la información
 * que la persona necesita para consentir el uso de sus datos. Resumirla sería debilitar eso.
 *
 * FUENTE: "Cuestionario de Caracterización (Ajustado).docx", párrafo de apertura.
 */
const INTRODUCCION =
  'El presente cuestionario tiene como propósito realizar la caracterización inicial de las ' +
  'actividades de capacitación y conocer necesidades, motivaciones y expectativas en materia de ' +
  'empleabilidad. La información recopilada permitirá orientar la oferta formativa hacia ' +
  'competencias pertinentes, considerando los desafíos de la transformación digital. La ' +
  'información será utilizada exclusivamente para los fines señalados y mejorar las acciones de ' +
  'capacitación. No existen respuestas correctas ni incorrectas; se solicita responder de acuerdo ' +
  'con su situación actual.';

/** WhatsApp admite hasta 3 botones y hasta 10 filas de lista. Con más opciones —la pregunta de
 *  región tiene 16— se cae a una lista numerada por texto, que no tiene tope y es igual de
 *  accesible. */
const MAX_BOTONES = 3;
const MAX_LISTA = 10;

const T = {
  intro: (intro: string, total: number) =>
    `Antes de comenzar el curso necesito hacerte ${total} preguntas breves 📋\n\n${intro}\n\n` +
    `Son de alternativas y toma un par de minutos. Si necesitas cortar, escribe *salir* y retomamos donde quedaste.`,
  // El nombre del curso se lee de la base, no se escribe acá: un nombre a mano es exactamente lo
  // que quedó viejo cuando el currículo cambió.
  //
  // Y NO termina con "¿Comenzamos?". Un flujo determinista que cierra con una pregunta abierta deja
  // que el modelo interprete la respuesta: en el piloto un "si" quedó suelto y el tutor lo resolvió
  // contra una conversación anterior sobre el quiz, anunciando una pregunta que nadie iba a enviar.
  // El cierre entrega un botón, cuya respuesta no admite dos lecturas.
  completa: (curso: string) =>
    `¡Listo! ✅ Gracias por responder.\n\nYa quedaste inscrito en *${curso}*: son 8 microcápsulas ` +
    `de 5 a 7 minutos y puedes hacerlas a tu ritmo.`,
  pausada: (hechas: number, total: number) =>
    `Sin problema, dejamos el cuestionario en la pregunta ${hechas + 1} de ${total} 🙂 ` +
    `Cuando quieras seguir, escribe *cuestionario*.`,
  noEntendi: (n: number) =>
    `No pude identificar tu respuesta 🤔 Elige una de las alternativas ${n > MAX_LISTA ? 'escribiendo su número' : 'con los botones'}.`,
  bloqueada: (faltan: number) =>
    `Para partir con el curso me falta terminar el cuestionario: quedan ${faltan} pregunta${faltan > 1 ? 's' : ''} 📋 ` +
    `Escribe *cuestionario* y las vemos rápido.`,
};

/** Envía una pregunta con la mejor afordancia disponible según su cantidad de opciones. */
async function enviarPregunta(
  waId: string, provider: MessagingProvider, p: PreguntaCaracterizacion, pos: string,
): Promise<void> {
  const n = p.opciones.length;
  const cuerpo = `📋 *Pregunta ${pos}*\n${p.enunciado}`;

  if (n <= MAX_BOTONES) {
    await provider.enviarBotones(waId, cuerpo, p.opciones.map((o) => ({ id: `car:${o.id}`, titulo: o.texto.slice(0, 20) })));
    return;
  }
  // El título de una fila admite pocos caracteres: va el número, y el texto completo en la
  // descripción, que admite 72. Hoy la opción más larga del cuestionario tiene 42, pero si el
  // material creciera la alternativa aparecería cortada en pantalla sin aviso — como pasó en la
  // práctica de la microcápsula 1. Cuando no cabe, el texto va en el cuerpo.
  const TOPE_FILA = 72;
  if (n <= MAX_LISTA && p.opciones.every((o) => o.texto.length <= TOPE_FILA)) {
    await provider.enviarLista(
      waId, cuerpo, 'Responder',
      p.opciones.map((o, i) => ({ id: `car:${o.id}`, titulo: String(i + 1), descripcion: o.texto })),
    );
    return;
  }
  if (n <= MAX_LISTA) {
    const enumeradas = p.opciones.map((o, i) => `${i + 1}. ${o.texto}`).join('\n');
    await provider.enviarLista(
      waId, `${cuerpo}\n\n${enumeradas}`, 'Responder',
      p.opciones.map((o, i) => ({ id: `car:${o.id}`, titulo: String(i + 1) })),
    );
    return;
  }
  // Más de 10 opciones: lista numerada por texto. La persona responde con el número.
  const lineas = p.opciones.map((o, i) => `${i + 1}. ${o.texto}`).join('\n');
  await provider.enviarTexto(waId, `${cuerpo}\n\n${lineas}\n\n_Responde con el número._`);
}

/** Interpreta la respuesta: id del botón/fila, número de la lista, o el texto de la opción. */
export function interpretarRespuesta(
  msg: InboundMessage, opciones: { id: string; texto: string }[],
): string | null {
  if (msg.type === 'interactive' && msg.interactiveReplyId?.startsWith('car:')) {
    const id = msg.interactiveReplyId.slice('car:'.length);
    return opciones.some((o) => o.id === id) ? id : null;
  }
  const t = textoDe(msg);
  if (!t) return null;
  const num = t.match(/^\s*(\d{1,2})\b/);
  if (num) {
    const i = Number(num[1]) - 1;
    if (i >= 0 && i < opciones.length) return opciones[i].id;
  }
  // Texto exacto de la alternativa (el botón devuelve su título, y hay gente que la escribe).
  const p = plano(t);
  const exacta = opciones.find((o) => plano(o.texto) === p);
  if (exacta) return exacta.id;
  const empieza = opciones.filter((o) => plano(o.texto).startsWith(p) && p.length >= 4);
  return empieza.length === 1 ? empieza[0].id : null;
}

export type ResultadoCaracterizacion = { handled: boolean };

/**
 * Interceptor del pipeline. Corre DESPUÉS del registro (necesita persona) y ANTES de todo lo
 * demás: el plan pone la caracterización como primer paso de la experiencia.
 */
export async function manejarCaracterizacion(
  msg: InboundMessage, persona: Persona | null, provider: MessagingProvider,
): Promise<ResultadoCaracterizacion> {
  if (!dbEnabled() || !persona) return { handled: false };
  const waId = msg.from;
  const estado = await getJson<EstadoCaracterizacion>(KEY(waId));
  const texto = plano(textoDe(msg));

  // ── Cuestionario en curso ─────────────────────────────────────────────────
  if (estado) {
    if (RE_PAUSA.test(texto)) {
      await kvDel(KEY(waId));
      const [hechas, total] = await Promise.all([respondidas(persona.id), totalPreguntas()]);
      await provider.enviarTexto(waId, T.pausada(hechas, total));
      return { handled: true };
    }
    const optionId = interpretarRespuesta(msg, estado.opciones);
    if (!optionId) {
      await provider.enviarTexto(waId, T.noEntendi(estado.opciones.length));
      return { handled: true };
    }
    const ok = await guardarRespuesta(persona.id, estado.questionId, optionId);
    if (!ok) {
      await kvDel(KEY(waId));
      await provider.enviarTexto(waId, 'Tuve un problema guardando tu respuesta 😕 Escribe *cuestionario* para retomarlo.');
      return { handled: true };
    }
    await kvDel(KEY(waId));
    return continuar(waId, persona, provider, false);
  }

  // ── Sin cuestionario en curso ─────────────────────────────────────────────
  // Se arranca si la persona lo pide explícitamente, o si intenta empezar el curso sin haberlo
  // completado: el plan lo define como requisito previo.
  const yaCompleta = await cerrarSiCompleta(persona.id);
  if (yaCompleta) return { handled: false };
  if (!RE_INICIAR.test(texto)) return { handled: false };
  return continuar(waId, persona, provider, true);
}

/** Envía la siguiente pregunta, o cierra el cuestionario si ya no quedan. */
async function continuar(
  waId: string, persona: Persona, provider: MessagingProvider, conIntro: boolean,
): Promise<ResultadoCaracterizacion> {
  const p = await siguientePregunta(persona.id);
  if (!p) {
    const completa = await cerrarSiCompleta(persona.id);
    if (completa) {
      void audit({ type: 'caracterizacion_completada', dialogId: waId, detail: { personId: persona.id } });
      // Se inscribe ACÁ: acaba de responder once preguntas para entrar al curso, y volver a
      // preguntarle si quiere entrar es fricción. El plan define esta secuencia — cuestionario,
      // después la ruta.
      const estado = await inscribir(persona.id);
      const curso = estado?.curso?.nombre ?? (await cursoActivo())?.nombre ?? 'el curso';
      if (estado?.inscrito) void audit({ type: 'inscripcion', dialogId: waId, detail: { curso: estado.curso?.codigo } });
      await provider.enviarBotones(waId, T.completa(curso), [
        { id: 'arranque:comenzar', titulo: 'Comenzar ahora' },
      ]);
    }
    return { handled: true };
  }

  const [hechas, total] = await Promise.all([respondidas(persona.id), totalPreguntas()]);
  if (conIntro && hechas === 0) {
    await provider.enviarTexto(waId, T.intro(INTRODUCCION, total));
    void audit({ type: 'caracterizacion_iniciada', dialogId: waId, detail: { personId: persona.id } });
  }

  await setJson(
    KEY(waId),
    { questionId: p.id, opciones: p.opciones.map((o) => ({ id: o.id, texto: o.texto })), enviadaEn: Date.now() } satisfies EstadoCaracterizacion,
    TTL,
  );
  await enviarPregunta(waId, provider, p, `${hechas + 1} de ${total}`);
  return { handled: true };
}

/** Mensaje para cuando alguien intenta avanzar en el curso sin haber completado el cuestionario. */
export function textoBloqueo(faltan: number): string {
  return T.bloqueada(faltan);
}
