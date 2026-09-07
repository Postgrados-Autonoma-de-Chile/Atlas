import { getJson, setJson } from '../store/kv';
import { audit } from '../obs/audit';
import type { InboundMessage, MessagingProvider } from '../messaging/types';

// Contención ante una señal de riesgo vital, ANTES de cualquier otro flujo.
//
// POR QUÉ ES DETERMINISTA Y VA PRIMERO
// El prompt del tutor ya tiene la instrucción de dejar el rol académico y entregar ayuda real. Pero
// esa instrucción solo puede actuar sobre los mensajes que llegan al modelo, y el registro, el
// cuestionario, la práctica y la ficha de cierre son flujos deterministas que lo interceptan antes.
//
// Pasó de verdad en el piloto: alguien escribió "tengo pensamientos suicidas" en el campo del
// NOMBRE. El registro lo aceptó como nombre y siguió pidiendo el apellido. La frase quedó guardada
// en la ficha de la persona —habría salido impresa en un certificado de la Universidad— y el
// protocolo nunca se activó, porque ese mensaje no pasó por el modelo.
//
// Por eso este interceptor corre antes que todos: es la aplicación más literal de la regla del
// proyecto —lo que puede ser determinista no se delega al modelo— en el único caso donde el costo
// de que el modelo no colabore no es pedagógico.
//
// ALCANCE, A PROPÓSITO ACOTADO
// Detecta expresiones INEQUÍVOCAS de ideación suicida o autolesión. No intenta detectar violencia
// ni angustia general: eso depende del contexto de la conversación, y el modelo —que sí lo tiene—
// lo maneja con la instrucción del prompt. Un detector por patrones que intente cubrir el matiz
// termina interrumpiendo a quien habla del contenido del curso, y una contención que llega cuando
// no corresponde enseña a ignorarla.
//
// Esta capa no reemplaza al protocolo del prompt: lo respalda en los puntos donde el prompt no
// llega.

/** Minúsculas sin acentos: el \b de JS es ASCII y "í" no cuenta como carácter de palabra. */
const plano = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

type Senal = { etiqueta: 'suicidio' | 'autolesion'; re: RegExp };

/**
 * Cada patrón es explícito por sí solo. Nada de palabras suelas como "morir" o "matar", que en
 * Chile aparecen a cada rato en sentido figurado.
 */
const SENALES: Senal[] = [
  { etiqueta: 'suicidio', re: /\b(pensamiento|idea|ideacion)(s|es)?\s+(suicidas?|de\s+suicidio)\b/ },
  { etiqueta: 'suicidio', re: /\bsuicid(arme|arse|arm[eé]|io|arlo)\b/ },
  { etiqueta: 'suicidio', re: /\bme\s+(quiero|voy\s+a|iba\s+a|pienso)\s+(matar|suicidar)\b/ },
  { etiqueta: 'suicidio', re: /\bquiero\s+(matarme|suicidarme)\b/ },
  { etiqueta: 'suicidio', re: /\b(quitarme|terminar\s+con|acabar\s+con)\s+(mi\s+vida|la\s+vida)\b/ },
  { etiqueta: 'suicidio', re: /\b(ya\s+)?no\s+quiero\s+(vivir|seguir\s+viviendo|existir|estar\s+aqui|seguir\s+aqui)\b/ },
  { etiqueta: 'suicidio', re: /\b(no\s+le\s+veo|no\s+tiene)\s+sentido\s+(a\s+)?(seguir\s+)?vivi(r|endo)\b/ },
  { etiqueta: 'suicidio', re: /\bmejor\s+(estaria|seria)\s+muerto\b/ },
  { etiqueta: 'suicidio', re: /\b(me\s+)?(quiero|voy\s+a)\s+morir(me)?\b/ }, // filtrado por HIPERBOLE
  { etiqueta: 'autolesion', re: /\b(hacerme|hacer\s?me)\s+dano\b/ },
  { etiqueta: 'autolesion', re: /\bme\s+(quiero|voy\s+a|estoy)\s+cort(ar|ando)(me)?\b/ },
  { etiqueta: 'autolesion', re: /\bautolesion(arme|arse|es)?\b/ },
];

/**
 * Usos figurados. "Me quiero morir de risa", "me muero de hambre", "matar el tiempo": en Chile son
 * cotidianos, y una contención disparada ahí le enseña a la persona a ignorarla.
 *
 * Solo filtra los patrones ambiguos —los que hablan de morir—; una frase como "tengo pensamientos
 * suicidas" no se descarta por nada.
 */
const HIPERBOLE =
  /\bde\s+(risa|hambre|sue[ñn]o|frio|calor|amor|verguenza|ganas|aburrimiento|emocion|nervios|rabia|sed|pena)\b|\bmatar\s+el\s+tiempo\b|\bme\s+muero\s+de\b/;

/** Patrones que sí admiten lectura figurada, y por eso pasan por el filtro. */
const AMBIGUOS = new Set([SENALES[8].re.source]);

/** Etiqueta de la señal detectada, o null. Nunca devuelve el texto: no se guarda lo que escribió. */
export function detectarSenalRiesgo(texto: string): Senal['etiqueta'] | null {
  const t = plano(texto);
  if (!t.trim()) return null;
  for (const s of SENALES) {
    if (!s.re.test(t)) continue;
    if (AMBIGUOS.has(s.re.source) && HIPERBOLE.test(t)) continue;
    return s.etiqueta;
  }
  return null;
}

const KEY = (waId: string) => `bienestar:${waId}`;
const TTL = 12 * 3600; // repetir el mismo texto completo cada vez suena a máquina

const CONTENCION =
  'Voy a detener el curso un momento, porque lo que me escribiste importa más 💙\n\n' +
  'No soy una persona y no puedo acompañarte como necesitas, pero hay gente que sí puede, ahora ' +
  'mismo y gratis:\n\n' +
  '• *4141* — línea de prevención del suicidio de Salud Responde, 24 horas\n' +
  '• *600 360 7777* — Salud Responde, opción salud mental\n' +
  '• *131* — si hay peligro inmediato\n\n' +
  'Si puedes, cuéntale también a alguien de confianza que esté cerca. No tienes que resolverlo solo.\n\n' +
  'El curso te espera; no hay ningún apuro.';

const CONTENCION_BREVE =
  'Sigo acá 💙 Y sigue en pie lo importante: *4141* (prevención del suicidio, 24 horas), ' +
  '*600 360 7777* (Salud Responde) o *131* si hay peligro inmediato. ' +
  'Hablar con alguien de confianza que esté cerca también ayuda.';

const textoDe = (m: InboundMessage) =>
  (m.type === 'text' ? m.text ?? '' : m.type === 'interactive' ? m.interactiveReplyTitle ?? '' : '').trim();

export type ResultadoBienestar = { handled: boolean };

/**
 * Interceptor. Corre ANTES del registro, así que también protege el caso que lo motivó: la frase
 * no se guarda como nombre, y la pregunta del flujo queda intacta para el mensaje siguiente.
 *
 * Consume el turno SIEMPRE que detecta: seguir pidiendo el apellido después de eso sería peor que
 * no tener protocolo.
 */
export async function manejarBienestar(
  msg: InboundMessage, provider: MessagingProvider,
): Promise<ResultadoBienestar> {
  const etiqueta = detectarSenalRiesgo(textoDe(msg));
  if (!etiqueta) return { handled: false };

  const waId = msg.from;
  const yaAvisado = Boolean(await getJson<{ en: number }>(KEY(waId)));
  await provider.enviarTexto(waId, yaAvisado ? CONTENCION_BREVE : CONTENCION);
  await setJson(KEY(waId), { en: Date.now() }, TTL);

  // La auditoría registra QUE ocurrió y de qué tipo, nunca lo que la persona escribió. Es el dato
  // que el equipo del programa necesita para hacer seguimiento; el texto no le agrega nada y sí
  // agregaría un dato sensible en reposo.
  void audit({ type: 'alerta_bienestar', dialogId: waId, detail: { senal: etiqueta, repetida: yaAvisado } });
  return { handled: true };
}
