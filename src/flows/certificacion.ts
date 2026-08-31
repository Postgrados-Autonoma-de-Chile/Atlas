import crypto from 'crypto';
import { getJson, setJson, kvDel } from '../store/kv';
import { dbEnabled } from '../store/db';
import { certificadoDePersona, marcarDatosPendientes, emitir, marcarEnviado, type Certificado } from '../store/certificados';
import { tieneRut, guardarRut, marcarEmailVerificado, type Persona } from '../store/personas';
import { validarRut, normalizarRut } from '../core/identidad';
import { generarCertificadoPdf } from '../cert/pdf';
import { enviarCorreo } from '../cert/mailer';
import { audit } from '../obs/audit';
import { config } from '../config';
import { log } from '../log';
import type { InboundMessage, MessagingProvider } from '../messaging/types';

// Flujo DETERMINISTA de certificación (Fase 8), interceptado antes del motor — como registro y
// evaluación: los datos sensibles (RUT) y la emisión jamás pasan por el LLM.
// Secuencia (§15): requisitos ya verificados (certificate 'elegible' nace en la tx que completa el
// curso) → RUT validado módulo 11 + confirmación → código de verificación al correo → emisión con
// folio → PDF por correo → confirmación por WhatsApp.

type Etapa = 'rut' | 'confirma_rut' | 'email_codigo';
type EstadoCert = { etapa: Etapa; certId: string; rutCandidato?: string; intentos: number };

const KEY = (waId: string) => `cert:${waId}`;
const CODE_KEY = (personId: string) => `certcode:${personId}`;
const TTL = 48 * 3600;
const CODE_TTL = 15 * 60;

const RE_CERT = /\b(certificado|certificarme|certificacion|diploma)\b/;
const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const textoDe = (m: InboundMessage) => (m.type === 'text' ? m.text ?? '' : m.type === 'interactive' ? m.interactiveReplyTitle ?? '' : '').trim();

export function generarCodigo(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/** Enmascara el email para mostrarlo en chat (r***a@dominio.cl). */
function enmascarar(email: string): string {
  const [u, d] = email.split('@');
  if (!d) return '***';
  return `${u.length <= 2 ? u[0] ?? '*' : `${u[0]}***${u[u.length - 1]}`}@${d}`;
}

async function enviarCodigo(persona: Persona, provider: MessagingProvider, waId: string): Promise<boolean> {
  if (!persona.email) return false;
  const codigo = generarCodigo();
  await setJson(CODE_KEY(persona.id), { codigo }, CODE_TTL);
  const r = await enviarCorreo({
    to: persona.email,
    subject: 'Tu código de verificación — ATLAS UAutónoma',
    html: `<p>Hola ${persona.nombre ?? ''},</p><p>Tu código de verificación para emitir tu certificado es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${codigo}</p><p>Vence en 15 minutos. Si no lo solicitaste, ignora este correo.</p><p>— ATLAS, Universidad Autónoma de Chile</p>`,
  });
  if (!r.ok) return false;
  await provider.enviarTexto(waId, `📧 Te envié un código de 6 dígitos a *${enmascarar(persona.email)}*. Escríbelo aquí para verificar tu correo (vence en 15 min; escribe *reenviar* si no te llega).`);
  return true;
}

/**
 * Enlace "Agregar a mi perfil" de LinkedIn. Es un formulario prellenado de LinkedIn (no una API):
 * abre el perfil de la persona con los campos de la certificación ya completos, y ella confirma.
 * Requiere certUrl público — de ahí que dependa de la misma página de verificación que el QR.
 */
export function enlaceLinkedIn(curso: string, folio: string, urlVerificacion: string, fecha: Date): string {
  const q = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: curso,
    organizationName: 'Universidad Autónoma de Chile',
    issueYear: String(fecha.getFullYear()),
    issueMonth: String(fecha.getMonth() + 1),
    certUrl: urlVerificacion,
    certId: folio,
  });
  return `https://www.linkedin.com/profile/add?${q.toString()}`;
}

/** Emite + envía el certificado. Devuelve true si el correo salió. */
async function emitirYEnviar(cert: Certificado, persona: Persona, provider: MessagingProvider, waId: string): Promise<void> {
  const emision = await emitir(cert.id);
  if (!emision) {
    await provider.enviarTexto(waId, 'Tuve un problema técnico emitiendo tu certificado 😕 Inténtalo de nuevo en unos minutos escribiendo *certificado*.');
    return;
  }
  const { folio, codigo } = emision;
  void audit({ type: 'certificado_emitido', dialogId: waId, detail: { folio } });

  const nombre = [persona.nombre, persona.apellido].filter(Boolean).join(' ') || 'Estudiante';
  const fecha = new Date();
  // Sin BASE_URL no hay a dónde apuntar: se omiten el QR y el botón de LinkedIn en vez de generar
  // enlaces rotos en un documento que la persona va a mostrarle a un empleador.
  const urlVerificacion = config.baseUrl && codigo
    ? `${config.baseUrl}/verificar/${encodeURIComponent(folio)}?c=${encodeURIComponent(codigo)}`
    : undefined;
  let enviado = false;
  try {
    const pdf = await generarCertificadoPdf({ nombreCompleto: nombre, curso: cert.cursoNombre, minutos: cert.minutos, folio, fecha, urlVerificacion });
    const correo = await enviarCorreo({
      to: persona.email ?? '',
      subject: `Tu certificado — ${cert.cursoNombre} (folio ${folio})`,
      html:
        `<p>Hola ${persona.nombre ?? ''},</p>` +
        `<p>¡Felicitaciones! 🎉 Completaste el curso <b>${cert.cursoNombre}</b>.</p>` +
        `<p>Adjuntamos tu certificado (folio <b>${folio}</b>).</p>` +
        (urlVerificacion
          ? `<p>Puedes verificar su validez en cualquier momento aquí:<br><a href="${urlVerificacion}">${urlVerificacion}</a></p>` +
            `<p><a href="${enlaceLinkedIn(cert.cursoNombre, folio, urlVerificacion, fecha)}" ` +
            `style="display:inline-block;padding:10px 18px;background:#0a66c2;color:#fff;text-decoration:none;border-radius:4px">` +
            `Agregar a mi perfil de LinkedIn</a></p>`
          : '') +
        `<p>— ATLAS, Universidad Autónoma de Chile</p>`,
      adjuntos: [{ filename: `certificado-${folio}.pdf`, content: pdf }],
    });
    enviado = correo.ok;
  } catch (e) {
    log.error('certificacion: generación/envío falló', { err: String(e) });
  }

  if (enviado) {
    await marcarEnviado(cert.id);
    await provider.enviarTexto(waId, `🎓 ¡Listo, ${persona.nombre ?? ''}! Tu certificado (folio *${folio}*) fue enviado a *${enmascarar(persona.email ?? '')}*. ¡Felicitaciones por completar tu curso! 🎉`);
    void audit({ type: 'certificado_enviado', dialogId: waId, detail: { folio } });
  } else {
    await provider.enviarTexto(waId, `Tu certificado quedó emitido (folio *${folio}*) pero no pude enviarlo por correo ahora mismo 😕 Escribe *certificado* más tarde y lo reintento.`);
  }
}

export type ResultadoCert = { handled: boolean };

/** Interceptor del pipeline (tras registro y evaluación, antes del motor). */
export async function manejarCertificacion(
  msg: InboundMessage, persona: Persona | null, provider: MessagingProvider,
): Promise<ResultadoCert> {
  if (!dbEnabled() || !persona) return { handled: false };
  const waId = msg.from;
  const estado = await getJson<EstadoCert>(KEY(waId));
  const texto = textoDe(msg);
  const pideCert = RE_CERT.test(plano(texto));

  // ── Sin flujo activo: ¿corresponde iniciarlo? ───────────────────────────────
  if (!estado) {
    if (!pideCert) return { handled: false };
    const cert = await certificadoDePersona(persona.id);
    if (!cert) return { handled: false }; // sin curso completado: que el tutor explique el avance real
    if (cert.estado === 'enviado') {
      await provider.enviarTexto(waId, `Tu certificado ya fue emitido y enviado a tu correo ✅ (folio *${cert.folio}*). Si no lo encuentras, revisa spam o avísame para reenviarlo escribiendo *reenviar certificado*.`);
      return { handled: true };
    }
    if (cert.estado === 'emitido') {
      await emitirYEnviar(cert, persona, provider, waId); // reintento de envío (folio ya asignado)
      return { handled: true };
    }
    // elegible | datos_pendientes → capturar lo que falte.
    await marcarDatosPendientes(cert.id);
    if (await tieneRut(persona.id)) {
      const ok = await enviarCodigo(persona, provider, waId);
      if (!ok) {
        await provider.enviarTexto(waId, 'No pude enviarte el código de verificación ahora mismo 😕 Inténtalo más tarde escribiendo *certificado*.');
        return { handled: true };
      }
      await setJson(KEY(waId), { etapa: 'email_codigo', certId: cert.id, intentos: 0 } satisfies EstadoCert, TTL);
      return { handled: true };
    }
    await provider.enviarTexto(
      waId,
      `🎓 ¡Vamos por tu certificado de *${cert.cursoNombre}*! Para emitirlo a tu nombre necesito tu *RUT* (se guarda protegido y solo se usa para tu certificado). Escríbelo con guion, por ejemplo 12345678-9:`,
    );
    await setJson(KEY(waId), { etapa: 'rut', certId: cert.id, intentos: 0 } satisfies EstadoCert, TTL);
    void audit({ type: 'certificacion_iniciada', dialogId: waId });
    return { handled: true };
  }

  // ── Flujo activo ────────────────────────────────────────────────────────────
  const cert = await certificadoDePersona(persona.id);
  if (!cert) {
    await kvDel(KEY(waId));
    return { handled: false };
  }

  switch (estado.etapa) {
    case 'rut': {
      if (msg.type !== 'text') {
        await provider.enviarTexto(waId, 'Escríbeme tu RUT por texto, por favor 🙂 (ej: 12345678-9)');
        return { handled: true };
      }
      if (!validarRut(texto)) {
        if (estado.intentos >= 2) {
          await kvDel(KEY(waId));
          await provider.enviarTexto(waId, 'Ese RUT no me calza 🤔 Dejemos el certificado en pausa; cuando quieras retomarlo escribe *certificado*. ¿Te ayudo con algo más?');
          return { handled: true };
        }
        await setJson(KEY(waId), { ...estado, intentos: estado.intentos + 1 }, TTL);
        await provider.enviarTexto(waId, 'Ese RUT no parece válido 🤔 Revísalo y escríbelo de nuevo (con guion y dígito verificador, ej: 12345678-9):');
        return { handled: true };
      }
      const rut = normalizarRut(texto);
      await setJson(KEY(waId), { ...estado, etapa: 'confirma_rut', rutCandidato: rut, intentos: 0 }, TTL);
      await provider.enviarBotones(waId, `Anoté: *${rut}*\n¿Está correcto?`, [
        { id: 'rut_ok', titulo: 'Sí, es correcto' },
        { id: 'rut_no', titulo: 'Corregirlo' },
      ]);
      return { handled: true };
    }

    case 'confirma_rut': {
      const replyId = msg.type === 'interactive' ? msg.interactiveReplyId ?? '' : '';
      if (replyId === 'rut_ok' || /^(si+|correcto)\b/.test(plano(texto))) {
        const r = await guardarRut(persona.id, estado.rutCandidato ?? '');
        if (r === 'rut_en_uso') {
          await kvDel(KEY(waId));
          await provider.enviarTexto(waId, 'Ese RUT ya está asociado a otra cuenta de ATLAS 🤔 Para proteger tu certificado, el equipo de la Universidad revisará el caso y te contactará. Dejé el registro hecho.');
          void audit({ type: 'alerta_identidad_rut', dialogId: waId, detail: { certId: estado.certId } });
          return { handled: true };
        }
        if (r !== 'ok') {
          await kvDel(KEY(waId));
          await provider.enviarTexto(waId, 'Tuve un problema técnico guardando tu RUT 😕 Inténtalo de nuevo en unos minutos escribiendo *certificado*.');
          return { handled: true };
        }
        const okCodigo = await enviarCodigo(persona, provider, waId);
        if (!okCodigo) {
          await kvDel(KEY(waId));
          await provider.enviarTexto(waId, 'Guardé tu RUT ✅ pero no pude enviarte el código de verificación al correo 😕 Inténtalo más tarde escribiendo *certificado*.');
          return { handled: true };
        }
        await setJson(KEY(waId), { ...estado, etapa: 'email_codigo', rutCandidato: undefined, intentos: 0 }, TTL);
        return { handled: true };
      }
      // Corregir
      await setJson(KEY(waId), { ...estado, etapa: 'rut', rutCandidato: undefined, intentos: 0 }, TTL);
      await provider.enviarTexto(waId, 'Sin problema 🙂 Escríbeme tu RUT de nuevo (ej: 12345678-9):');
      return { handled: true };
    }

    case 'email_codigo': {
      if (/\breenviar\b/.test(plano(texto))) {
        const ok = await enviarCodigo(persona, provider, waId);
        if (!ok) await provider.enviarTexto(waId, 'No pude reenviar el código ahora mismo 😕 Inténtalo en unos minutos.');
        return { handled: true };
      }
      const guardado = await getJson<{ codigo: string }>(CODE_KEY(persona.id));
      // El código puede venir DENTRO de otro texto, no solo. WhatsApp incluye el mensaje citado
      // cuando se responde a uno, y la gente escribe "mi código es 123456". Se buscan grupos de 6
      // dígitos en vez de exigir que el mensaje entero sea el código. \b a ambos lados para que un
      // RUT (19864724-1) no aporte un falso "198647".
      const compacto = texto.replace(/\s+/g, '');
      const candidatos = [...new Set([...(texto.match(/\b\d{6}\b/g) ?? []), ...(compacto.match(/\b\d{6}\b/g) ?? [])])];

      // SIN ningún grupo de 6 dígitos no hay código equivocado: la persona escribió otra cosa
      // ("certificado", "no me llegó nada"). Contarlo como intento fallido la expulsaba del flujo
      // a los tres mensajes sin haber errado un código jamás — se detectó en el piloto, cuando un
      // mensaje con la palabra "certificado" recibió "Ese código no coincide". Se guía sin gastar
      // intentos: los intentos son para códigos realmente equivocados.
      if (candidatos.length === 0) {
        await provider.enviarTexto(
          waId,
          RE_CERT.test(plano(texto))
            ? 'Ya estamos en el último paso 🙂 Solo falta el código de *6 dígitos* que te llegó al correo (revisa también spam). Si no te llegó, escribe *reenviar*.'
            : 'Para emitir tu certificado necesito el código de *6 dígitos* que te llegó al correo (revisa también spam). Escríbelo aquí, o escribe *reenviar* si no te llega.',
        );
        return { handled: true };
      }

      if (!guardado || !candidatos.includes(guardado.codigo)) {
        if (estado.intentos >= 2) {
          await kvDel(KEY(waId));
          await kvDel(CODE_KEY(persona.id));
          await provider.enviarTexto(waId, 'Ese código no coincide 🤔 Dejemos el certificado en pausa; escribe *certificado* para intentarlo de nuevo con un código fresco.');
          return { handled: true };
        }
        await setJson(KEY(waId), { ...estado, intentos: estado.intentos + 1 }, TTL);
        await provider.enviarTexto(waId, 'Ese código no coincide 🤔 Revisa tu correo (también spam) y escríbelo de nuevo, o escribe *reenviar*.');
        return { handled: true };
      }
      await kvDel(CODE_KEY(persona.id));
      await kvDel(KEY(waId));
      await marcarEmailVerificado(persona.id);
      void audit({ type: 'email_verificado', dialogId: waId });
      await emitirYEnviar(cert, persona, provider, waId);
      return { handled: true };
    }
  }

  await kvDel(KEY(waId));
  return { handled: false };
}
