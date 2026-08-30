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
};

const KEY = (waId: string) => `evaluacion:${waId}`;
const OFERTA_KEY = (waId: string) => `quiz:oferta:${waId}`;
const TTL = 2 * 3600; // una evaluación abandonada expira a las 2h (el attempt queda abierto en BD)

const LETRAS = ['A', 'B', 'C', 'D'];
/** Minúsculas sin acentos: el \b de JS es ASCII y trata "í" como no-palabra ("sí\b" fallaría). */
const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const RE_INICIO = /\b(quiz|mini[- ]?quiz|evaluacion|practicar|prueba)\b/;
const RE_SI = /^(si+|dale|ok(ay)?|ya|bueno|claro|vamos|obvio|por ?favor)\b/;
const RE_NO = /^(no+|ahora no|despues|luego)\b/;
const RE_SALIR = /\b(salir|pausa(r)?|detener|cancelar|despues sigo)\b/;

/** Marca que hay un quiz ofrecido tras completar una lección (la escribe el toolRunner). */
export async function marcarOfertaQuiz(waId: string): Promise<void> {
  await setJson(OFERTA_KEY(waId), { en: Date.now() }, 3600);
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
      await provider.enviarTexto(waId, `${cierre}\n\n¿Seguimos con la próxima microcápsula? Escribe *continuar* cuando quieras.`);
      void audit({ type: 'evaluacion_finalizada', dialogId: waId, detail: { quiz: estado.quizId, intento: estado.intentoN, correctas: r.correctas, total: r.total } });
      return { handled: true };
    }

    await setJson(KEY(waId), { ...estado, pregunta: r.siguiente, enviadaEn: Date.now() }, TTL);
    await enviarPregunta(waId, provider, r.siguiente, `${r.siguiente.orden} de ${estado.total}`);
    return { handled: true };
  }

  // ── Sin evaluación activa: ¿corresponde iniciar una? ────────────────────────
  const texto = plano(textoDe(msg));
  const oferta = await getJson<{ en: number }>(OFERTA_KEY(waId));
  const aceptaOferta = oferta && msg.type !== 'interactive' && RE_SI.test(texto);
  const pideQuiz = RE_INICIO.test(texto);
  if (oferta && RE_NO.test(texto)) {
    await kvDel(OFERTA_KEY(waId)); // rechazó la oferta: el mensaje sigue al tutor con normalidad
    return { handled: false };
  }
  if (!aceptaOferta && !pideQuiz) return { handled: false };

  const pendiente = await quizParaIniciar(persona.id);
  if (!pendiente) return { handled: false }; // sin lecciones completadas con quiz: que el tutor explique

  const inicio = await iniciarAttempt(pendiente.enrollmentId, pendiente.quizId);
  if (!inicio) return { handled: false };
  await kvDel(OFERTA_KEY(waId));
  await setJson(KEY(waId), {
    attemptId: inicio.attemptId, quizId: inicio.quizId, titulo: inicio.titulo,
    intentoN: inicio.intentoN, total: inicio.total, pregunta: inicio.primera, enviadaEn: Date.now(),
  } satisfies EstadoEvaluacion, TTL);
  await provider.enviarTexto(
    waId,
    `🧠 *${inicio.titulo}* — ${inicio.total} pregunta${inicio.total > 1 ? 's' : ''}${inicio.intentoN > 1 ? ` (intento ${inicio.intentoN})` : ''}. Esto es para practicar: no hay nota, solo aprendizaje. Escribe *salir* si quieres pausar.`,
  );
  await enviarPregunta(waId, provider, inicio.primera, `1 de ${inicio.total}`);
  void audit({ type: 'evaluacion_iniciada', dialogId: waId, detail: { quiz: inicio.quizId, intento: inicio.intentoN } });
  return { handled: true };
}
