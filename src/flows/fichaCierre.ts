import { getJson, setJson, kvDel } from '../store/kv';
import { dbEnabled } from '../store/db';
import {
  abrirFicha, fichaDePersona, guardarCampo, cerrarSiCompleta, siguienteCampo,
  notaDeMicrocapsula2, type CampoFicha,
} from '../store/fichaCierre';
import { completarLeccionActual } from '../store/cursos';
import { audit } from '../obs/audit';
import type { InboundMessage, MessagingProvider } from '../messaging/types';
import type { Persona } from '../store/personas';

// Producto de cierre del nivel: la ficha breve de resolución de problema con apoyo de IA.
//
// FUENTE: plan curricular — «Ficha breve de resolución de problema con apoyo de IA, que incluya:
// problema identificado, pregunta formulada, respuesta obtenida, verificación básica y decisión o
// acción posible». Es la evidencia de aplicación de la ruta completa, y el documento aclara que
// «funciona como evidencia de aplicación, sin constituir una evaluación formal».
//
// Los cinco campos son los cinco pasos de la ruta, así que llenar la ficha ES recorrer
// DEFINO → PREGUNTO → ORGANIZO → VERIFICO → DECIDO sobre un caso real. Por eso cada pregunta
// nombra su paso: es el cierre de lo que la persona viene practicando desde la cápsula 2.
//
// Flujo DETERMINISTA: son cinco campos de texto libre que se guardan tal cual. El LLM no participa
// —no hay nada que interpretar— y hacerlo pasar por el modelo solo agregaría costo y el riesgo de
// que reescriba las palabras de la persona.

type EstadoFicha = { fichaId: string; campo: CampoFicha; enviadaEn: number };

const KEY = (waId: string) => `ficha:${waId}`;
const TTL = 7 * 24 * 3600; // el plan no exige completarla de una sentada

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const textoDe = (m: InboundMessage) =>
  (m.type === 'text' ? m.text ?? '' : m.type === 'interactive' ? m.interactiveReplyTitle ?? '' : '').trim();

const RE_PAUSA = /\b(salir|pausa(r)?|despues|luego|mas tarde)\b/;
const RE_INICIAR = /\b(ficha|actividad final|cierre|producto)\b/;
const MINIMO_UTIL = 8; // menos que esto no es una respuesta, es un tipeo

/** Consigna de cada campo, redactada sobre el enunciado del plan y nombrando su paso de la ruta. */
const PREGUNTA: Record<CampoFicha, { paso: string; texto: string }> = {
  problema: {
    paso: 'DEFINO',
    texto: '*DEFINO* — ¿Qué situación quieres resolver? Cuéntame qué ocurre, qué necesitas y qué condiciones hay que considerar.',
  },
  pregunta_formulada: {
    paso: 'PREGUNTO',
    texto: '*PREGUNTO* — ¿Cómo se lo pedirías a una IA? Escribe la pregunta o instrucción tal como la formularías, con su contexto.',
  },
  respuesta_obtenida: {
    paso: 'ORGANIZO',
    texto: '*ORGANIZO* — ¿Qué te respondió, o cómo pedirías que te la organice? Puede ser una lista, una tabla, pasos o ventajas y desventajas.',
  },
  verificacion: {
    paso: 'VERIFICO',
    texto: '*VERIFICO* — ¿Qué de eso conviene comprobar antes de actuar, y dónde lo comprobarías?',
  },
  decision: {
    paso: 'DECIDO',
    texto: '*DECIDO* — Con todo eso, ¿cuál es tu próximo paso? Puede ser una acción o una fuente a la que acudir.',
  },
};

const T = {
  intro: (nota: string | null) =>
    '📝 *Actividad de cierre*\n\nVamos a armar tu ficha aplicando la ruta completa a un caso real. ' +
    'Son cinco preguntas breves, una por cada paso. No hay respuestas correctas ni incorrectas: es tu evidencia de aplicación.\n\n' +
    (nota ? `Como referencia, en la microcápsula 2 escribiste: «${nota}». Puedes partir de ahí o cambiar de tema.\n\n` : '') +
    'Si necesitas cortar, escribe *salir* y retomamos donde quedaste.',
  corto: 'Cuéntame un poco más 🙂 Con una frase basta, pero necesito algo con qué trabajar.',
  pausada: (paso: string) =>
    `Sin problema, dejamos tu ficha en el paso *${paso}* 📝 Escribe *ficha* cuando quieras seguir.`,
  completa: (finCurso: boolean) =>
    '✅ *Tu ficha quedó lista.* Recorriste los cinco pasos: DEFINO, PREGUNTO, ORGANIZO, VERIFICO y DECIDO.\n\n' +
    'Eso es exactamente lo que este curso quería dejarte: una forma de usar la inteligencia artificial que ' +
    'sirve para cualquier problema, no solo para el que trabajaste hoy.\n\n' +
    (finCurso
      ? '🎓 Con esto completaste el curso. Escribe *certificado* para obtener el tuyo.'
      : 'Escribe *continuar* para seguir con lo que queda.'),
};

export type ResultadoFicha = { handled: boolean };

/**
 * Interceptor del pipeline. Corre antes de la certificación: la ficha es el requisito de la
 * microcápsula 8, y el plan pide evidencia de aplicación, no solo que el contenido se haya enviado.
 */
export async function manejarFichaCierre(
  msg: InboundMessage, persona: Persona | null, provider: MessagingProvider,
): Promise<ResultadoFicha> {
  if (!dbEnabled() || !persona) return { handled: false };
  const waId = msg.from;
  const estado = await getJson<EstadoFicha>(KEY(waId));
  const texto = textoDe(msg);

  // ── Ficha en curso ────────────────────────────────────────────────────────
  if (estado) {
    if (RE_PAUSA.test(plano(texto))) {
      await kvDel(KEY(waId));
      await provider.enviarTexto(waId, T.pausada(PREGUNTA[estado.campo].paso));
      return { handled: true };
    }
    if (texto.length < MINIMO_UTIL) {
      await provider.enviarTexto(waId, T.corto);
      return { handled: true };
    }
    const ok = await guardarCampo(estado.fichaId, estado.campo, texto);
    if (!ok) {
      await kvDel(KEY(waId));
      await provider.enviarTexto(waId, 'Tuve un problema guardando eso 😕 Escribe *ficha* para retomarla.');
      return { handled: true };
    }
    await kvDel(KEY(waId));
    return avanzar(waId, persona, provider, false);
  }

  // ── Sin ficha en curso: solo arranca si la piden ─────────────────────────
  if (!RE_INICIAR.test(plano(texto))) return { handled: false };
  const f = await fichaDePersona(persona.id);
  if (f?.completadoEn) {
    await provider.enviarTexto(waId, 'Tu ficha de cierre ya está completa ✅ Escribe *certificado* si quieres tu certificado.');
    return { handled: true };
  }
  return avanzar(waId, persona, provider, true);
}

/**
 * Arranca la ficha desde la microcápsula 8, con la modalidad que la persona eligió en su
 * interacción ("situación propia" o "caso preparado"). Ambas son válidas según el documento.
 */
export async function iniciarFicha(
  waId: string, persona: Persona, provider: MessagingProvider,
  modalidad?: 'propia' | 'caso_preparado',
): Promise<boolean> {
  const f = await abrirFicha(persona.id, modalidad);
  if (!f || f.completadoEn) return false;
  const r = await avanzar(waId, persona, provider, true);
  return r.handled;
}

async function avanzar(
  waId: string, persona: Persona, provider: MessagingProvider, conIntro: boolean,
): Promise<ResultadoFicha> {
  const f = (await fichaDePersona(persona.id)) ?? (await abrirFicha(persona.id));
  if (!f) return { handled: false };

  const pendiente = siguienteCampo(f);
  if (!pendiente) {
    const cerrada = await cerrarSiCompleta(f.id);
    if (cerrada) {
      // La ficha ES la evidencia de la microcápsula 8: completarla completa la cápsula, y con ella
      // el curso. El plan pide evidencia de aplicación, no que el contenido se haya enviado.
      const r = await completarLeccionActual(persona.id);
      const finCurso = Boolean(r && 'cursoCompletado' in r && r.cursoCompletado);
      await provider.enviarTexto(waId, T.completa(finCurso));
      void audit({ type: 'ficha_cierre_completada', dialogId: waId, detail: { fichaId: f.id, finCurso } });
    }
    return { handled: true };
  }

  if (conIntro && !f.problema) {
    const nota = await notaDeMicrocapsula2(persona.id);
    await provider.enviarTexto(waId, T.intro(nota));
    void audit({ type: 'ficha_cierre_iniciada', dialogId: waId, detail: { fichaId: f.id, modalidad: f.modalidad } });
  }

  await setJson(KEY(waId), { fichaId: f.id, campo: pendiente.campo, enviadaEn: Date.now() } satisfies EstadoFicha, TTL);
  const n = 1 + ['problema', 'pregunta_formulada', 'respuesta_obtenida', 'verificacion', 'decision'].indexOf(pendiente.campo);
  await provider.enviarTexto(waId, `*${n} de 5* · ${PREGUNTA[pendiente.campo].texto}`);
  return { handled: true };
}
