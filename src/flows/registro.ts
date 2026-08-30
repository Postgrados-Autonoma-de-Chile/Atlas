import { getJson, setJson, kvDel } from '../store/kv';
import { dbEnabled } from '../store/db';
import { buscarPersonaPorWaId, crearPersonaRegistrada, type Persona } from '../store/personas';
import { validarNombre, validarEmail, normalizarEmail, capitalizar } from '../core/identidad';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { InboundMessage, MessagingProvider } from '../messaging/types';

// Flujo de REGISTRO conversacional (Fase 3), según docs/specs/captura-identidad-estudiante.md.
// Es un asistente DETERMINISTA que corre ANTES del motor LLM: la validación de datos personales
// (nombre, email) y el consentimiento no se delegan al modelo. Reglas de la spec:
//   - consentimiento PRIMERO (botones), un dato por mensaje, confirmación del email,
//   - máximo 2 reintentos por campo (al tercero se pausa y el mensaje pasa al tutor),
//   - persistencia atómica: la persona se crea recién con la captura mínima completa.
// El RUT NO se pide aquí: solo al certificar (F8).

export const CONSENT_VERSION = 'v1-2026-08 (piloto)';

type Etapa = 'consentimiento' | 'nombre' | 'apellido' | 'email' | 'confirma_email' | 'rechazado' | 'pausado';

type EstadoRegistro = {
  etapa: Etapa;
  nombre?: string;
  apellido?: string;
  emailCandidato?: string;
  intentos: number;
};

const KEY = (waId: string) => `registro:${waId}`;
const TTL = 72 * 3600; // el estado del asistente vive 72h; la persona creada es permanente

export type ResultadoRegistro = {
  /** true = este flujo consumió el mensaje (ya respondió); el motor no corre. */
  handled: boolean;
  /** Persona registrada (si existe) para el contexto del tutor. */
  persona?: Persona | null;
};

const T = {
  consentimiento:
    'Hola 👋 Soy *ATLAS*, el tutor virtual de la Universidad Autónoma de Chile. Te acompañaré en tu curso: clases, dudas y evaluaciones, todo por WhatsApp.\n\n' +
    'Para registrarte necesito tu nombre, apellido y correo. Tus datos se usan solo para tu formación y certificado, se guardan protegidos y puedes pedir su eliminación cuando quieras. También te enviaré recordatorios del curso (puedes desactivarlos diciendo "no enviar recordatorios").\n\n¿Aceptas continuar?',
  rechazo:
    'Sin problema 🙂 Cuando quieras registrarte, escríbeme "quiero registrarme". Igual puedo responder tus preguntas generales.',
  nombre: '¡Gracias! Partamos: ¿cuál es tu *nombre*? (solo el nombre)',
  nombreInvalido: 'Mmm, eso no parece un nombre 🙂 ¿Me lo escribes de nuevo? (solo tu nombre, sin números)',
  apellido: (nombre: string) => `Un gusto, ${nombre} 👋 ¿Cuál es tu *apellido*?`,
  apellidoInvalido: 'Ese apellido no me calza 🙂 ¿Me lo repites? (solo el apellido, sin números)',
  email: 'Perfecto. Ahora tu *correo electrónico* (ahí llegará tu certificado al finalizar):',
  emailInvalido: 'Ese correo no parece válido 🤔 Revísalo y escríbelo de nuevo (ej: nombre@dominio.cl):',
  pausa: 'No hay problema, sigamos conversando y retomamos tu registro después 🙂',
  confirmaEmail: (email: string) => `Anoté: *${email}*\n¿Está correcto?`,
  errorCrear: 'Tuve un problema técnico guardando tu registro 😕 Intentémoslo de nuevo en un momento.',
  bienvenida: (nombre: string) =>
    `¡Listo, ${nombre}! ✅ Quedaste registrado.\n\nCuando tu curso esté disponible te avisaré por aquí. Mientras tanto, puedes preguntarme lo que necesites.`,
};

async function getEstado(waId: string): Promise<EstadoRegistro | null> {
  return (await getJson<EstadoRegistro>(KEY(waId))) ?? null;
}
async function setEstado(waId: string, e: EstadoRegistro): Promise<void> {
  await setJson(KEY(waId), e, TTL);
}

/** Texto "útil" del mensaje para el asistente (texto plano o título del botón elegido). */
function textoDe(msg: InboundMessage): string {
  if (msg.type === 'text') return (msg.text ?? '').trim();
  if (msg.type === 'interactive') return (msg.interactiveReplyTitle ?? '').trim();
  return '';
}

/** Minúsculas sin acentos para los matchers: el \b de JS es ASCII ("sí\b" fallaría). */
const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Punto de entrada del flujo. Devuelve handled=true si el asistente consumió el mensaje.
 * Sin BD (dev sin DATABASE_URL) el registro se omite y el tutor responde normalmente.
 */
export async function manejarRegistro(msg: InboundMessage, provider: MessagingProvider): Promise<ResultadoRegistro> {
  if (!dbEnabled()) return { handled: false, persona: null };

  const persona = await buscarPersonaPorWaId(msg.from);
  if (persona) return { handled: false, persona };

  const estado = (await getEstado(msg.from)) ?? { etapa: 'consentimiento' as Etapa, intentos: -1 };
  const replyId = msg.type === 'interactive' ? msg.interactiveReplyId ?? '' : '';
  const texto = textoDe(msg);

  // Registro pausado o rechazado: solo se reactiva si la persona lo pide.
  if (estado.etapa === 'rechazado' || estado.etapa === 'pausado') {
    if (/registrar|registro|inscribir/i.test(texto)) {
      await setEstado(msg.from, { etapa: 'consentimiento', intentos: 0 });
      await enviarConsentimiento(msg.from, provider);
      return { handled: true };
    }
    return { handled: false, persona: null };
  }

  // Primer contacto: ofrecer consentimiento.
  if (estado.intentos === -1) {
    await setEstado(msg.from, { etapa: 'consentimiento', intentos: 0 });
    await enviarConsentimiento(msg.from, provider);
    void audit({ type: 'registro_inicio', dialogId: msg.from });
    return { handled: true };
  }

  switch (estado.etapa) {
    case 'consentimiento': {
      if (replyId === 'reg_si' || /^(si+|acepto|dale|ok)\b/.test(plano(texto))) {
        await setEstado(msg.from, { etapa: 'nombre', intentos: 0 });
        await provider.enviarTexto(msg.from, T.nombre);
        void audit({ type: 'registro_consentimiento', dialogId: msg.from, detail: { version: CONSENT_VERSION } });
        return { handled: true };
      }
      if (replyId === 'reg_no' || /^(no+|ahora no|despues)\b/.test(plano(texto))) {
        await setEstado(msg.from, { etapa: 'rechazado', intentos: 0 });
        await provider.enviarTexto(msg.from, T.rechazo);
        void audit({ type: 'registro_rechazado', dialogId: msg.from });
        return { handled: true };
      }
      // Respuesta libre que no es sí/no: re-ofrecer una vez con los botones.
      await enviarConsentimiento(msg.from, provider);
      return { handled: true };
    }

    case 'nombre':
      return capturarCampo(msg, provider, estado, {
        valida: validarNombre,
        alValido: async (v) => {
          const nombre = capitalizar(v);
          await setEstado(msg.from, { ...estado, etapa: 'apellido', nombre, intentos: 0 });
          await provider.enviarTexto(msg.from, T.apellido(nombre));
        },
        invalido: T.nombreInvalido,
      });

    case 'apellido':
      return capturarCampo(msg, provider, estado, {
        valida: validarNombre,
        alValido: async (v) => {
          await setEstado(msg.from, { ...estado, etapa: 'email', apellido: capitalizar(v), intentos: 0 });
          await provider.enviarTexto(msg.from, T.email);
        },
        invalido: T.apellidoInvalido,
      });

    case 'email':
      return capturarCampo(msg, provider, estado, {
        valida: validarEmail,
        alValido: async (v) => {
          const email = normalizarEmail(v);
          await setEstado(msg.from, { ...estado, etapa: 'confirma_email', emailCandidato: email, intentos: 0 });
          await provider.enviarBotones(msg.from, T.confirmaEmail(email), [
            { id: 'email_ok', titulo: 'Sí, es correcto' },
            { id: 'email_no', titulo: 'Corregirlo' },
          ]);
        },
        invalido: T.emailInvalido,
      });

    case 'confirma_email': {
      if (replyId === 'email_ok' || /^(si+|correcto)\b/.test(plano(texto))) {
        const { nombre, apellido, emailCandidato } = estado;
        if (!nombre || !apellido || !emailCandidato) {
          // Estado corrupto (no debería pasar): reiniciar limpio.
          await setEstado(msg.from, { etapa: 'consentimiento', intentos: 0 });
          await enviarConsentimiento(msg.from, provider);
          return { handled: true };
        }
        const persona = await crearPersonaRegistrada({
          waId: msg.from, nombre, apellido, email: emailCandidato, consentVersion: CONSENT_VERSION,
        });
        if (!persona) {
          await provider.enviarTexto(msg.from, T.errorCrear);
          return { handled: true };
        }
        await kvDel(KEY(msg.from));
        await provider.enviarTexto(msg.from, T.bienvenida(persona.nombre ?? nombre));
        void audit({ type: 'registro_completo', dialogId: msg.from, detail: { personId: persona.id } });
        return { handled: true, persona };
      }
      // Corregir el correo (botón o texto).
      await setEstado(msg.from, { ...estado, etapa: 'email', emailCandidato: undefined, intentos: 0 });
      await provider.enviarTexto(msg.from, T.email);
      return { handled: true };
    }
  }

  log.warn('registro: etapa desconocida, reiniciando', { etapa: estado.etapa });
  await kvDel(KEY(msg.from));
  return { handled: false, persona: null };
}

async function enviarConsentimiento(waId: string, provider: MessagingProvider): Promise<void> {
  await provider.enviarBotones(waId, T.consentimiento, [
    { id: 'reg_si', titulo: 'Acepto' },
    { id: 'reg_no', titulo: 'Ahora no' },
  ]);
}

/** Captura genérica de un campo con validación y máximo 2 reintentos (al 3° falla → pausa). */
async function capturarCampo(
  msg: InboundMessage,
  provider: MessagingProvider,
  estado: EstadoRegistro,
  opts: { valida: (v: string) => boolean; alValido: (v: string) => Promise<void>; invalido: string },
): Promise<ResultadoRegistro> {
  const valor = textoDe(msg);
  if (valor && opts.valida(valor)) {
    await opts.alValido(valor);
    return { handled: true };
  }
  if (estado.intentos >= 2) {
    await setJson(KEY(msg.from), { ...estado, etapa: 'pausado' satisfies Etapa, intentos: 0 }, TTL);
    await provider.enviarTexto(msg.from, T.pausa);
    return { handled: false, persona: null }; // el mensaje sigue al tutor
  }
  await setJson(KEY(msg.from), { ...estado, intentos: estado.intentos + 1 }, TTL);
  await provider.enviarTexto(msg.from, opts.invalido);
  return { handled: true };
}
