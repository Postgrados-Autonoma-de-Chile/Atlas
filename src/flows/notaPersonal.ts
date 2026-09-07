import { getJson, setJson, kvDel } from '../store/kv';
import { dbEnabled } from '../store/db';
import { guardarNota } from '../store/fichaCierre';
import { audit } from '../obs/audit';
import type { InboundMessage, MessagingProvider } from '../messaging/types';
import type { Persona } from '../store/personas';

// "Mi necesidad": el campo personal de la microcápsula 2 (paso DEFINO).
//
// FUENTE: "Microcapsula 02 Cómo describir un problema de manera clara.docx"
//   · Secuencia, 3:30-4:25 — «Aplicación personal · Campo opcional · Redactar una frase sobre una
//     necesidad propia usando la pauta · "Piensa en una necesidad real. ¿Cómo la explicarías?" ·
//     No exigir envío.»
//   · Pantalla 5 "Mi necesidad" — «Escribe una frase breve sobre una situación que quieras
//     resolver» · Campo de texto opcional · «no prellenar el campo».
//   · Inventario — «Campo personal · 1 componente · Redacción opcional · No solicitar datos
//     sensibles.»
//   · §13 — «Si la plataforma permite persistencia, la frase personal puede recuperarse en la
//     cápsula 8.»
//
// Ese último punto es la razón de que esto exista: la ficha de cierre ya intenta leer esta frase
// (notaDeMicrocapsula2) y hasta ahora siempre la encontraba vacía, porque nada la escribía.
//
// OPCIONAL DE VERDAD: el documento dice «no exigir envío», así que saltarla es un camino de primera
// clase y no una excusa. Quien la salta pasa a la microcápsula siguiente igual, sin insistencia.

type EstadoNota = { leccionId: string; ofrecidaEn: number };

const KEY = (waId: string) => `nota:${waId}`;
const TTL = 3 * 3600;

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Saltarla es tan válido como escribirla: el documento no permite exigir el envío. */
const RE_SALTAR = /^(no|nada|paso|saltar|salta|omitir|luego|despues|mas tarde|continuar|siguiente|seguir|listo|ninguna)\b/;

/** Menos que esto no es una frase; se pide de nuevo una sola vez y después se sigue. */
const MINIMO = 12;

/**
 * Datos sensibles. El documento es explícito —«No solicitar datos sensibles», «El campo personal no
 * induce a ingresar datos sensibles ni información de terceros»— y esta frase se guarda y se vuelve
 * a mostrar en la cápsula 8, así que un RUT o un teléfono ahí quedarían persistidos sin necesidad.
 */
const RE_SENSIBLE = /\b\d{1,2}\.?\d{3}\.?\d{3}\s*-?\s*[\dkK]\b|\b\+?56\s?9\s?\d{4}\s?\d{4}\b|[\w.+-]+@[\w-]+\.[\w.]+/;

const T = {
  oferta:
    '✍️ *Mi necesidad* (opcional)\n\n' +
    'Piensa en una necesidad real tuya y escríbela en una frase, usando la pauta: qué ocurre, qué ' +
    'necesitas y qué condiciones importan.\n\n' +
    'Te la voy a guardar para la actividad de cierre, así no la escribes de nuevo. ' +
    'Si prefieres seguir, escribe *continuar* y pasamos a la próxima microcápsula.',
  corta:
    'Con una frase basta 🙂 Cuéntame qué necesitas resolver, o escribe *continuar* si prefieres seguir.',
  sensible:
    'Mejor sin datos personales ahí 🙂 No hacen falta para describir una necesidad, y esta frase queda ' +
    'guardada. Cuéntamela sin RUT, teléfono ni correo — o escribe *continuar* y seguimos.',
  guardada:
    '✅ Anotada. La vas a ver de nuevo en la actividad de cierre, para resolverla con la ruta completa.\n\n' +
    '¿Seguimos con la próxima microcápsula? Escribe *continuar* cuando quieras.',
  saltada:
    'Sin problema 🙂 ¿Seguimos con la próxima microcápsula? Escribe *continuar* cuando quieras.',
};

const textoDe = (m: InboundMessage) =>
  (m.type === 'text' ? m.text ?? '' : m.type === 'interactive' ? m.interactiveReplyTitle ?? '' : '').trim();

/** Abre el campo tras cerrar la práctica de la microcápsula 2. */
export async function ofrecerNotaPersonal(
  waId: string, provider: MessagingProvider, leccionId: string,
): Promise<void> {
  await setJson(KEY(waId), { leccionId, ofrecidaEn: Date.now() } satisfies EstadoNota, TTL);
  await provider.enviarTexto(waId, T.oferta);
}

export type ResultadoNota = { handled: boolean };

/**
 * Interceptor. Solo actúa mientras el campo está abierto: fuera de esa ventana no toca nada.
 *
 * No reintenta indefinidamente. Si la frase queda corta o trae datos personales se explica una vez;
 * a la segunda se cierra el campo y se sigue con el curso. Insistir con un campo que el documento
 * declara opcional sería convertirlo en un requisito que el plan no establece.
 */
export async function manejarNotaPersonal(
  msg: InboundMessage, persona: Persona | null, provider: MessagingProvider,
): Promise<ResultadoNota> {
  if (!dbEnabled() || !persona) return { handled: false };
  const waId = msg.from;
  const estado = await getJson<EstadoNota>(KEY(waId));
  if (!estado) return { handled: false };

  const texto = textoDe(msg);
  if (RE_SALTAR.test(plano(texto))) {
    await kvDel(KEY(waId));
    await provider.enviarTexto(waId, T.saltada);
    void audit({ type: 'nota_personal_saltada', dialogId: waId });
    return { handled: true };
  }

  if (RE_SENSIBLE.test(texto)) {
    await kvDel(KEY(waId));
    await provider.enviarTexto(waId, T.sensible);
    // No se guarda ni se registra el texto: es exactamente lo que no debía persistir.
    void audit({ type: 'nota_personal_rechazada', dialogId: waId, detail: { motivo: 'dato_sensible' } });
    return { handled: true };
  }

  if (texto.length < MINIMO) {
    await kvDel(KEY(waId));
    await provider.enviarTexto(waId, T.corta);
    return { handled: true };
  }

  const ok = await guardarNota(persona.id, estado.leccionId, texto);
  await kvDel(KEY(waId));
  await provider.enviarTexto(
    waId,
    ok ? T.guardada : 'No pude guardarla 😕 No te preocupes, la actividad de cierre te la va a volver a pedir.\n\n¿Seguimos? Escribe *continuar*.',
  );
  if (ok) void audit({ type: 'nota_personal_guardada', dialogId: waId, detail: { largo: texto.length } });
  return { handled: true };
}
