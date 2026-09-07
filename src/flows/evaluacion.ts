import { getJson, setJson, kvDel } from '../store/kv';
import { dbEnabled } from '../store/db';
import { quizParaIniciar, iniciarAttempt, registrarRespuesta, quizzesPendientes,
  type PreguntaConOpciones, type Interaccion } from '../store/evaluaciones';
import { estadoAcademico } from '../store/cursos';
import { ofrecerNotaPersonal } from './notaPersonal';
import { log } from '../log';
import { audit } from '../obs/audit';
import type { InboundMessage, MessagingProvider } from '../messaging/types';
import type { Persona } from '../store/personas';

// Flujo DETERMINISTA del momento "Lo intento" de cada microcápsula.
//
// FUENTE: plan curricular del Nivel Inicial — «Cada microcápsula incorpora al menos una acción
// breve del participante: elegir, ordenar, comparar, clasificar, mejorar una solicitud o aplicar
// una pauta», con retroalimentación inmediata. La certificación es por finalización y SIN
// evaluación formal, así que esto no es un examen: es práctica.
//
// Cuatro formas, tomadas de los documentos de las 8 microcápsulas:
//   seleccion_unica     una opción es la mejor (cápsulas 1 y 3)
//   clasificacion       cada fragmento va a una categoría (2, 4, 5 y 7)
//   seleccion_multiple  elegir al menos N casos, ninguno incorrecto (6)
//   eleccion            elegir modalidad, ambas válidas (8)
//
// El plan es explícito en cómo retroalimentar: «Retroalimentar las decisiones explicando el
// criterio, no solo indicando correcto o incorrecto». Por eso el criterio del documento se entrega
// UNA vez al cerrar la actividad, y no repetido en cada ítem — en la cápsula 5 serían seis veces
// el mismo párrafo.
//
// Flujo DETERMINISTA (Fase 7): intercepta las respuestas ANTES del motor LLM.
// El parsing de la alternativa elegida es exacto (id de botón/lista o texto A-D / V-F), el registro
// es transaccional y la retroalimentación nace de la explicación DOCENTE guardada en la pregunta —
// "evaluar para enseñar": corregir → decir la correcta → explicar el porqué → invitar a seguir.

type EstadoEvaluacion = {
  attemptId: string;
  quizId: string;
  titulo: string;
  intentoN: number;
  total: number;
  pregunta: PreguntaConOpciones;
  enviadaEn: number; // epoch ms → tiempo de respuesta
  /** El quiz nació de la ÚLTIMA microcápsula: al cerrarlo hay que apuntar al certificado y no
   *  invitar a "continuar" con una microcápsula que ya no existe. */
  finCurso?: boolean;
  /** Metadatos curriculares de la actividad: tipo, consigna, criterio y mínimo requerido. */
  interaccion?: Interaccion;
  /** Cuántos ítems ya respondió, para las actividades con mínimo (cápsula 6). */
  respondidos?: number;
  /** Este ítem ya tuvo su revisión sin penalización: la próxima respuesta cierra y avanza. */
  reintentado?: boolean;
  /** Microcápsula de la que nació la práctica. La 2 (DEFINO) ofrece después su campo personal. */
  leccionId?: string;
  pasoRuta?: string | null;
};

/** De qué microcápsula nació el quiz pendiente. */
export type OrigenQuiz = { lessonId: string; pasoRuta: string | null };

const KEY = (waId: string) => `evaluacion:${waId}`;
const PENDIENTE_KEY = (waId: string) => `quiz:pendiente:${waId}`;
const TTL = 2 * 3600; // una evaluación abandonada expira a las 2h (el attempt queda abierto en BD)

// Hasta 6: la clasificación de la cápsula 4 ofrece 5 categorías y con A-D no alcanzaban.
const LETRAS = ['A', 'B', 'C', 'D', 'E', 'F'];
/** Minúsculas sin acentos: el \b de JS es ASCII y trata "í" como no-palabra ("sí\b" fallaría). */
const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const RE_INICIO = /\b(quiz|mini[- ]?quiz|evaluacion|practicar|prueba)\b/;
const RE_SALIR = /\b(salir|pausa(r)?|detener|cancelar|despues sigo)\b/;

/**
 * Marca que, terminado este turno, corresponde ENVIAR el mini-quiz de la microcápsula que el
 * estudiante acaba de completar. La escribe el toolRunner al procesar completar_leccion.
 *
 * El quiz ya no se ofrece: se conduce siempre. La decisión pedagógica es que la práctica no sea
 * opcional — en el piloto, ofrecerlo significó que 7 de 9 microcápsulas quedaran sin evaluar,
 * porque "sigamos" es más fácil que "sí". El estudiante puede saltárselo escribiendo *salir*, pero
 * el camino por omisión es practicar.
 *
 * El TTL es corto porque este marcador solo vive entre la ejecución de la herramienta y el envío de
 * la respuesta del tutor, dentro del mismo turno.
 */
export async function marcarQuizPendiente(
  waId: string, finCurso: boolean, origen?: OrigenQuiz,
): Promise<void> {
  await setJson(PENDIENTE_KEY(waId), { en: Date.now(), finCurso, origen: origen ?? null }, 300);
}

/** ¿Quedó un quiz pendiente de enviar en este turno? Lo consume (lectura destructiva). */
export async function tomarQuizPendiente(
  waId: string,
): Promise<{ finCurso: boolean; origen: OrigenQuiz | null } | null> {
  const p = await getJson<{ en: number; finCurso: boolean; origen?: OrigenQuiz | null }>(PENDIENTE_KEY(waId));
  if (!p) return null;
  await kvDel(PENDIENTE_KEY(waId));
  return { finCurso: Boolean(p.finCurso), origen: p.origen ?? null };
}

/** Texto plano o título del botón. */
const textoDe = (m: InboundMessage) => (m.type === 'text' ? m.text ?? '' : m.type === 'interactive' ? m.interactiveReplyTitle ?? '' : '').trim();

/** Mapea la respuesta del estudiante a una opción de la pregunta (id interactivo o texto A-D/V-F). */
export function mapearRespuestaAOpcion(msg: InboundMessage, pregunta: PreguntaConOpciones): string | null {
  if (msg.type === 'interactive' && msg.interactiveReplyId?.startsWith('resp:')) {
    const optionId = msg.interactiveReplyId.slice('resp:'.length);
    return pregunta.opciones.some((o) => o.id === optionId) ? optionId : null;
  }
  const t = textoDe(msg).toUpperCase().replace(/[.)]$/, '').trim();
  if (!t) return null;
  if (pregunta.tipo === 'verdadero_falso') {
    if (/^(V|VERDADERO)$/.test(t)) return pregunta.opciones.find((o) => o.texto === 'Verdadero')?.id ?? null;
    if (/^(F|FALSO)$/.test(t)) return pregunta.opciones.find((o) => o.texto === 'Falso')?.id ?? null;
    return null;
  }
  const idx = LETRAS.indexOf(t);
  if (idx >= 0 && pregunta.opciones[idx]) return pregunta.opciones[idx].id;
  return null;
}

/**
 * Envía un ítem con la mejor afordancia disponible.
 *
 * En una CLASIFICACIÓN el enunciado es el fragmento a ubicar y las opciones son las categorías; la
 * consigna general ya se envió al abrir la actividad, así que repetirla en cada ítem sería ruido.
 */
async function enviarPregunta(waId: string, provider: MessagingProvider, p: PreguntaConOpciones, pos: string): Promise<void> {
  const cuerpo = p.tipo === 'clasificacion'
    ? `*${pos}* · ¿Dónde ubicarías esto?\n\n“${p.itemTexto ?? p.enunciado}”`
    : `*Pregunta ${pos}*\n${p.enunciado}`;

  // Botones solo si TODAS las opciones caben enteras: el título de un botón de WhatsApp admite 20
  // caracteres, y una categoría como "fuente/persona competente" quedaría cortada en "fuente/persona
  // compe" — ilegible justo en la actividad donde entender la categoría es el aprendizaje. Cuando no
  // caben se usa lista, cuya descripción admite 72.
  const TOPE_BOTON = 20;
  if (p.opciones.length <= 3 && p.opciones.every((o) => o.texto.length <= TOPE_BOTON)) {
    await provider.enviarBotones(
      waId, cuerpo,
      p.opciones.map((o) => ({ id: `resp:${o.id}`, titulo: o.texto })),
    );
    return;
  }
  await provider.enviarLista(
    waId, cuerpo, 'Responder',
    p.opciones.slice(0, 10).map((o, i) => ({ id: `resp:${o.id}`, titulo: LETRAS[i] ?? String(i + 1), descripcion: o.texto.slice(0, 72) })),
  );
}

export type ResultadoFlujoEval = { handled: boolean };

/**
 * Interceptor del pipeline (corre tras el registro, antes del motor). Consume el mensaje cuando:
 * hay evaluación activa (respuesta/salida/re-guía), o corresponde iniciar una (oferta aceptada
 * o comando "quiz"). En cualquier otro caso, el mensaje sigue su curso al tutor.
 */
export async function manejarEvaluacion(
  msg: InboundMessage, persona: Persona | null, provider: MessagingProvider,
): Promise<ResultadoFlujoEval> {
  if (!dbEnabled() || !persona) return { handled: false };
  const waId = msg.from;
  const estado = await getJson<EstadoEvaluacion>(KEY(waId));

  // ── Evaluación en curso ─────────────────────────────────────────────────────
  if (estado) {
    const texto = textoDe(msg);
    if (RE_SALIR.test(plano(texto))) {
      await kvDel(KEY(waId));
      await provider.enviarTexto(waId, 'Listo, pausamos el mini-quiz 🙂 Cuando quieras retomarlo escribe *quiz*. ¿En qué te ayudo?');
      return { handled: true };
    }
    const optionId = mapearRespuestaAOpcion(msg, estado.pregunta);
    if (!optionId) {
      await provider.enviarTexto(waId, `Estamos en la pregunta ${estado.pregunta.orden} de ${estado.total} 🙂 Responde con los botones (o con la letra de la alternativa). Si prefieres seguir después, escribe *salir*.`);
      await enviarPregunta(waId, provider, estado.pregunta, `${estado.pregunta.orden} de ${estado.total}`);
      return { handled: true };
    }

    const tiempoMs = Date.now() - estado.enviadaEn;
    const feedbackBase = estado.pregunta.explicacion;
    const r = await registrarRespuesta(estado.attemptId, estado.quizId, estado.pregunta, optionId, tiempoMs, feedbackBase);
    if (!r) {
      await kvDel(KEY(waId));
      await provider.enviarTexto(waId, 'Tuve un problema técnico guardando tu respuesta 😕 Pausé el quiz; escribe *quiz* para reintentarlo.');
      return { handled: true };
    }

    const cuantosItems = Math.min(estado.interaccion?.minimoRequerido ?? estado.total, estado.total);

    // ── Refuerzo ante una respuesta equivocada ────────────────────────────────
    // El material lo define en cada microcápsula: «retroalimentación útil y no punitiva»,
    // «Permitir "Revisar de nuevo" sin penalización» (cápsula 1), «Permitir corregir hasta
    // completar» (2), «Debe permitir corrección inmediata» (4).
    //
    // Decir de inmediato cuál correspondía CLAUSURA esa corrección: ya no queda nada que revisar.
    // Así que en el primer error se devuelve el ítem una vez, sin revelar la respuesta y sin
    // penalización; la alternativa correcta se muestra recién después de esa segunda vuelta. Una
    // sola revisión por ítem: dos ya sería adivinar por descarte, y nadie queda atrapado.
    if (!r.sinRespuestaCorrecta && !r.esCorrecta && !estado.reintentado) {
      await setJson(KEY(waId), { ...estado, reintentado: true, enviadaEn: Date.now() }, TTL);
      await provider.enviarTexto(waId, 'Revisémoslo juntos 🤔 Esa no es la que mejor calza. No pasa nada: mira otra vez las alternativas y elige la que te parezca.');
      await enviarPregunta(waId, provider, estado.pregunta, `${estado.pregunta.orden} de ${cuantosItems}`);
      void audit({ type: 'refuerzo_evaluacion', dialogId: waId, detail: { quiz: estado.quizId, pregunta: estado.pregunta.orden } });
      return { handled: true };
    }

    // Retroalimentación del ítem. El plan pide explicar el CRITERIO y no solo marcar correcto o
    // incorrecto — y ese criterio es uno por actividad, así que va completo al CERRAR. Aquí solo
    // un acuse breve, para que la persona sepa cómo le fue sin recibir seis veces el mismo párrafo.
    let feedback: string;
    if (r.sinRespuestaCorrecta === true) {
      // Cápsulas 6 y 8: la elección es legítima cualquiera sea. Llamarla "correcta" o "incorrecta"
      // sería un error pedagógico, así que se acusa recibo y punto.
      feedback = `✅ Anotado: *${r.elegidaTexto}*`;
    } else if (r.esCorrecta) {
      feedback = estado.reintentado ? '✅ Ahí está.' : '✅ Correcto.';
    } else {
      feedback = `🤏 Ahí correspondía: *${r.correctaTexto}*`;
    }
    await provider.enviarTexto(waId, feedback);
    void audit({ type: 'respuesta_evaluacion', dialogId: waId, detail: { quiz: estado.quizId, pregunta: estado.pregunta.orden, correcta: r.esCorrecta, tiempoMs } });

    const respondidos = (estado.respondidos ?? 0) + 1;
    const minimo = estado.interaccion?.minimoRequerido ?? r.total;
    // Una actividad con mínimo (la cápsula 6 pide "al menos dos") se cierra al alcanzarlo: obligar
    // a recorrer los seis casos contradiría su propia consigna.
    const alcanzoMinimo = respondidos >= minimo;

    if (r.finalizado || !r.siguiente || alcanzoMinimo) {
      await kvDel(KEY(waId));
      // El criterio del documento, completo y una sola vez. Es la retroalimentación que el plan
      // manda entregar; el conteo de aciertos NO se muestra porque la certificación es por
      // finalización y sin evaluación formal: poner una nota inventaría una exigencia.
      const criterio = estado.interaccion?.retroalimentacion || r.explicacion;
      void audit({
        type: 'evaluacion_finalizada',
        dialogId: waId,
        detail: { quiz: estado.quizId, intento: estado.intentoN, correctas: r.correctas, total: r.total, respondidos },
      });

      // La microcápsula 2 (DEFINO) cierra con su campo personal y no con "¿seguimos?": su documento
      // define una "Aplicación personal" opcional —«Escribe una frase breve sobre una situación que
      // quieras resolver»— cuya frase se recupera en la cápsula 8. El traspaso al curso lo hace ese
      // flujo, cuando la persona escribe su frase o decide saltarla.
      if (!estado.finCurso && estado.pasoRuta === 'DEFINO' && estado.leccionId) {
        await provider.enviarTexto(waId, `💡 ${criterio}`);
        await ofrecerNotaPersonal(waId, provider, estado.leccionId);
        return { handled: true };
      }

      const siguientePaso = estado.finCurso
        ? 'Con esta terminaste todas las microcápsulas del curso 🎓 Escribe *certificado* para obtener el tuyo.'
        : '¿Seguimos con la próxima microcápsula? Escribe *continuar* cuando quieras.';
      await provider.enviarTexto(waId, `💡 ${criterio}\n\n${siguientePaso}`);
      return { handled: true };
    }

    await setJson(KEY(waId), { ...estado, pregunta: r.siguiente, enviadaEn: Date.now(), respondidos, reintentado: false }, TTL);
    await enviarPregunta(waId, provider, r.siguiente, `${r.siguiente.orden} de ${Math.min(minimo, estado.total)}`);
    return { handled: true };
  }

  // ── Sin evaluación activa: solo queda el comando explícito para REPETIR ────
  // El arranque tras completar una microcápsula ya no pasa por aquí: es automático (ver
  // iniciarQuizPendiente, que corre al cerrar el turno). Este camino sirve para que alguien
  // rehaga un quiz cuando quiera, escribiendo "quiz".
  const texto = plano(textoDe(msg));
  if (!RE_INICIO.test(texto)) return { handled: false };
  const arrancado = await iniciarQuiz(waId, persona, provider, false);
  if (arrancado) return { handled: true };

  // Pidió práctica y no hay ninguna que rendir. Se responde ACÁ y el mensaje NO sigue al modelo.
  //
  // Dejarlo pasar fue un error que le costó a un estudiante del piloto: el tutor —que por prompt
  // sabe que "el sistema envía la práctica"— le anunció "ahí viene tu quiz" y nunca llegó nada,
  // porque no tenía ninguna microcápsula completada. Prometer algo que el sistema no va a hacer es
  // exactamente lo que el diseño determinista existe para evitar.
  await explicarSinPractica(waId, persona, provider);
  return { handled: true };
}

/** Por qué no hay práctica, según el estado real del estudiante. Nunca lo decide el modelo. */
async function explicarSinPractica(
  waId: string, persona: Persona, provider: MessagingProvider,
): Promise<void> {
  const [estado, pendientes] = await Promise.all([
    estadoAcademico(persona.id),
    quizzesPendientes(persona.id),
  ]);

  // Hay práctica pendiente pero no se pudo abrir: es una falla técnica, no un estado del curso, y
  // decirle "no tienes práctica" sería mentirle.
  if (pendientes > 0) {
    log.warn('evaluacion: hay práctica pendiente pero no se pudo iniciar', { pendientes });
    await provider.enviarTexto(waId, 'Tuve un problema técnico al abrir tu práctica 😕 Escribe *quiz* de nuevo en un momento, por favor.');
    return;
  }
  if (!estado?.inscrito) {
    await provider.enviarTexto(waId, 'La práctica es parte del curso y llega sola al terminar cada microcápsula 🙂 Todavía no estás inscrito: escribe *empezar* y partimos.');
    return;
  }
  if (!estado.completadas) {
    await provider.enviarTexto(waId, 'La práctica llega sola justo después de cada microcápsula 🙂 Aún no terminas la primera: escribe *continuar* y te la entrego.');
    return;
  }
  await provider.enviarTexto(waId, 'Por ahora no tienes práctica pendiente: ya respondiste la de todo lo que llevas ✅ Escribe *continuar* para seguir con el curso.');
}

/**
 * Envía el mini-quiz pendiente, si lo hay. Se llama al FINAL del turno, después de que salió la
 * respuesta del tutor: si se lanzara dentro de la herramienta, las preguntas llegarían antes del
 * mensaje que felicita el avance y la conversación quedaría al revés.
 */
export async function iniciarQuizPendiente(
  waId: string, persona: Persona | null, provider: MessagingProvider,
): Promise<boolean> {
  if (!persona) return false;
  const pendiente = await tomarQuizPendiente(waId);
  if (!pendiente) return false;
  // Si el estudiante ya está en medio de otra evaluación, no se le encima una segunda.
  if (await getJson<EstadoEvaluacion>(KEY(waId))) return false;
  return iniciarQuiz(waId, persona, provider, pendiente.finCurso, pendiente.origen);
}

/** Arranca el quiz que corresponda al avance del estudiante. Devuelve false si no hay ninguno. */
async function iniciarQuiz(
  waId: string, persona: Persona, provider: MessagingProvider, finCurso: boolean,
  origen: OrigenQuiz | null = null,
): Promise<boolean> {
  const pendiente = await quizParaIniciar(persona.id);
  if (!pendiente) return false; // sin lecciones completadas con quiz: que el tutor explique
  const inicio = await iniciarAttempt(pendiente.enrollmentId, pendiente.quizId);
  if (!inicio) return false;
  // Defensivo: si el registro viniera sin metadatos de interacción —un quiz cargado antes de la
  // alineación curricular, o un doble en pruebas— se asume la forma más simple en vez de reventar
  // el turno del estudiante.
  const inter: Interaccion = inicio.interaccion ?? {
    tipo: 'seleccion_unica', consigna: null, retroalimentacion: null, minimoRequerido: inicio.total,
  };
  await setJson(KEY(waId), {
    attemptId: inicio.attemptId, quizId: inicio.quizId, titulo: inicio.titulo,
    intentoN: inicio.intentoN, total: inicio.total, pregunta: inicio.primera,
    enviadaEn: Date.now(), finCurso, interaccion: inter, respondidos: 0,
    leccionId: origen?.lessonId, pasoRuta: origen?.pasoRuta ?? null,
  } satisfies EstadoEvaluacion, TTL);

  // La CONSIGNA del documento abre la actividad: es el enunciado curricular, y en una
  // clasificación es lo único que explica qué se está pidiendo.
  const cuantos = Math.min(inter.minimoRequerido, inicio.total);
  const cabecera = `🧠 *Lo intento* — ${cuantos} ${cuantos > 1 ? 'respuestas' : 'respuesta'}` +
    `${inicio.intentoN > 1 ? ` (intento ${inicio.intentoN})` : ''}. Es práctica: no hay nota.`;
  await provider.enviarTexto(
    waId,
    inter.consigna ? `${cabecera}\n\n${inter.consigna}` : `${cabecera} Escribe *salir* si prefieres seguir después.`,
  );
  await enviarPregunta(waId, provider, inicio.primera, `1 de ${cuantos}`);
  void audit({ type: 'evaluacion_iniciada', dialogId: waId, detail: { quiz: inicio.quizId, intento: inicio.intentoN } });
  return true;
}
