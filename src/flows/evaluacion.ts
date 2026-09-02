import { getJson, setJson, kvDel } from '../store/kv';
import { dbEnabled } from '../store/db';
import { quizParaIniciar, iniciarAttempt, registrarRespuesta, type PreguntaConOpciones } from '../store/evaluaciones';
import { audit } from '../obs/audit';
import type { InboundMessage, MessagingProvider } from '../messaging/types';
import type { Persona } from '../store/personas';

// Flujo DETERMINISTA de evaluación (Fase 7): intercepta las respuestas ANTES del motor LLM.
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
};

const KEY = (waId: string) => `evaluacion:${waId}`;
const PENDIENTE_KEY = (waId: string) => `quiz:pendiente:${waId}`;
const TTL = 2 * 3600; // una evaluación abandonada expira a las 2h (el attempt queda abierto en BD)

const LETRAS = ['A', 'B', 'C', 'D'];
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
export async function marcarQuizPendiente(waId: string, finCurso: boolean): Promise<void> {
  await setJson(PENDIENTE_KEY(waId), { en: Date.now(), finCurso }, 300);
}

/** ¿Quedó un quiz pendiente de enviar en este turno? Lo consume (lectura destructiva). */
export async function tomarQuizPendiente(waId: string): Promise<{ finCurso: boolean } | null> {
  const p = await getJson<{ en: number; finCurso: boolean }>(PENDIENTE_KEY(waId));
  if (!p) return null;
  await kvDel(PENDIENTE_KEY(waId));
  return { finCurso: Boolean(p.finCurso) };
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

/** Envía una pregunta como mensaje interactivo: botones (V/F) o lista (selección múltiple). */
async function enviarPregunta(waId: string, provider: MessagingProvider, p: PreguntaConOpciones, pos: string): Promise<void> {
  const cuerpo = `*Pregunta ${pos}*\n${p.enunciado}`;
  if (p.tipo === 'verdadero_falso') {
    await provider.enviarBotones(waId, cuerpo, p.opciones.map((o) => ({ id: `resp:${o.id}`, titulo: o.texto })));
  } else {
    await provider.enviarLista(
      waId, cuerpo, 'Responder',
      p.opciones.map((o, i) => ({ id: `resp:${o.id}`, titulo: LETRAS[i], descripcion: o.texto.slice(0, 72) })),
    );
  }
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

    // Evaluar para enseñar: correcta → refuerzo; incorrecta → cuál era + porqué (explicación docente).
    const feedback = r.esCorrecta
      ? `✅ ¡Correcto!\n\n${r.explicacion}`
      : `🤏 Casi. La respuesta correcta era: *${r.correctaTexto}*\n\n${r.explicacion}\n\nSi quieres repasarlo, dime y lo vemos juntos.`;
    await provider.enviarTexto(waId, feedback);
    void audit({ type: 'respuesta_evaluacion', dialogId: waId, detail: { quiz: estado.quizId, pregunta: estado.pregunta.orden, correcta: r.esCorrecta, tiempoMs } });

    if (r.finalizado || !r.siguiente) {
      await kvDel(KEY(waId));
      const nota = `${r.correctas}/${r.total}`;
      const cierre = r.correctas === r.total
        ? `🎉 *${nota}* ¡Impecable! Dominaste esta microcápsula.`
        : `📘 Resultado: *${nota}*. Lo importante es lo que aprendiste en el camino — puedes repetirlo cuando quieras escribiendo *quiz*.`;
      const siguientePaso = estado.finCurso
        ? 'Con esta terminaste todas las microcápsulas del curso 🎓 Escribe *certificado* para obtener el tuyo.'
        : '¿Seguimos con la próxima microcápsula? Escribe *continuar* cuando quieras.';
      await provider.enviarTexto(waId, `${cierre}\n\n${siguientePaso}`);
      void audit({ type: 'evaluacion_finalizada', dialogId: waId, detail: { quiz: estado.quizId, intento: estado.intentoN, correctas: r.correctas, total: r.total } });
      return { handled: true };
    }

    await setJson(KEY(waId), { ...estado, pregunta: r.siguiente, enviadaEn: Date.now() }, TTL);
    await enviarPregunta(waId, provider, r.siguiente, `${r.siguiente.orden} de ${estado.total}`);
    return { handled: true };
  }

  // ── Sin evaluación activa: solo queda el comando explícito para REPETIR ────
  // El arranque tras completar una microcápsula ya no pasa por aquí: es automático (ver
  // iniciarQuizPendiente, que corre al cerrar el turno). Este camino sirve para que alguien
  // rehaga un quiz cuando quiera, escribiendo "quiz".
  const texto = plano(textoDe(msg));
  if (!RE_INICIO.test(texto)) return { handled: false };
  const arrancado = await iniciarQuiz(waId, persona, provider, false);
  return { handled: arrancado };
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
  return iniciarQuiz(waId, persona, provider, pendiente.finCurso);
}

/** Arranca el quiz que corresponda al avance del estudiante. Devuelve false si no hay ninguno. */
async function iniciarQuiz(
  waId: string, persona: Persona, provider: MessagingProvider, finCurso: boolean,
): Promise<boolean> {
  const pendiente = await quizParaIniciar(persona.id);
  if (!pendiente) return false; // sin lecciones completadas con quiz: que el tutor explique
  const inicio = await iniciarAttempt(pendiente.enrollmentId, pendiente.quizId);
  if (!inicio) return false;
  await setJson(KEY(waId), {
    attemptId: inicio.attemptId, quizId: inicio.quizId, titulo: inicio.titulo,
    intentoN: inicio.intentoN, total: inicio.total, pregunta: inicio.primera,
    enviadaEn: Date.now(), finCurso,
  } satisfies EstadoEvaluacion, TTL);
  await provider.enviarTexto(
    waId,
    `🧠 *${inicio.titulo}* — ${inicio.total} pregunta${inicio.total > 1 ? 's' : ''}${inicio.intentoN > 1 ? ` (intento ${inicio.intentoN})` : ''}. Esto es para practicar: no hay nota, solo aprendizaje. Escribe *salir* si prefieres seguir después.`,
  );
  await enviarPregunta(waId, provider, inicio.primera, `1 de ${inicio.total}`);
  void audit({ type: 'evaluacion_iniciada', dialogId: waId, detail: { quiz: inicio.quizId, intento: inicio.intentoN } });
  return true;
}
