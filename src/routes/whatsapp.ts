import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { log } from '../log';
import { safeEqual } from '../util/crypto';
import { once } from '../store/kv';
import { withKeyedLock } from '../util/distlock';
import { createSemaphore } from '../util/concurrency';
import { inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { runAgentTurn } from '../ai/agentLoop';
import { transcribeAudio } from '../ai/transcribe';
import { TUTOR_WHATSAPP_PROFILE } from '../core/channel';
import { getRequestContext, runWithRequestContext } from '../obs/requestContext';
import { messagingProvider, normalizarEntrante } from '../messaging';
import { pubsubHabilitado, publicarTurno } from '../messaging/colaTurnos';
import type { InboundMessage, MessagingProvider } from '../messaging';
import { manejarRegistro, CONSENT_VERSION } from '../flows/registro';
import { manejarEvaluacion } from '../flows/evaluacion';
import { manejarCertificacion } from '../flows/certificacion';
import { contextoAcademico } from '../store/cursos';
import { registrarOptOut, registrarOptIn } from '../store/personas';
import { cancelarDePersona, marcarFallidoPorWamid } from '../store/recordatorios';
import { esOptOutRecordatorios, esOptInRecordatorios } from '../reminders/motor';
import { setJson } from '../store/kv';
import { marcarRespondio } from '../store/invitaciones';

// Canal WhatsApp Cloud API (Fase 10a): webhook → normalización → dedupe → lock por conversación →
// motor del tutor → respuesta por el MessagingProvider.
//
// Pipeline heredado del webhook probado en producción del sistema anterior (ACK<1s, idempotencia,
// lock distribuido por conversación, semáforo por instancia). LÍMITE CONOCIDO de esta fase: el
// procesamiento ocurre en el mismo proceso tras el ACK (si la instancia muere, el turno se pierde);
// en Fase 11 el webhook publica a Pub/Sub y un worker consume. El dedupe es Redis fail-open; el
// respaldo UNIQUE en Postgres llega con el esquema académico (F3).

/** GET /webhooks/whatsapp — handshake de verificación que Meta llama al suscribir el webhook. */
export function metaVerify(req: Request, res: Response) {
  const mode = String(req.query['hub.mode'] ?? '');
  const token = String(req.query['hub.verify_token'] ?? '');
  const challenge = String(req.query['hub.challenge'] ?? '');
  if (mode === 'subscribe' && config.metaVerifyToken && safeEqual(token, config.metaVerifyToken)) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

/**
 * Verifica X-Hub-Signature-256 — prueba de que el POST viene de Meta. Requiere que index.ts capture
 * el body crudo (verify de express.json) en `req.rawBody`. Fail-closed en producción si falta el secreto.
 */
export function verifyMetaSignature(req: Request, res: Response, next: NextFunction) {
  if (!config.metaAppSecret) {
    // F12: fail-closed por defecto; solo DEV_FAIL_OPEN=true (prohibido en producción) abre en local.
    if (!config.devFailOpen) {
      return res.status(503).json({ error: 'META_APP_SECRET no configurado' });
    }
    log.warn('verifyMetaSignature: sin META_APP_SECRET (DEV_FAIL_OPEN activo — solo desarrollo)');
    return next();
  }
  const header = req.header('x-hub-signature-256') ?? '';
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!raw) {
    log.error('verifyMetaSignature: falta rawBody (falta el verify de express.json en index.ts)');
    return res.status(500).json({ error: 'rawBody no disponible' });
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', config.metaAppSecret).update(raw).digest('hex');
  if (!safeEqual(header, expected)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Backpressure por instancia (el lock por conversación, en cambio, es distribuido).
const turnLimit = createSemaphore(config.maxConcurrentTurns);

/** POST /webhooks/whatsapp — ACK inmediato y procesamiento en segundo plano. */
export function metaWebhook(req: Request, res: Response) {
  res.sendStatus(200);
  const requestId = getRequestContext()?.requestId ?? '-';
  const evento = normalizarEntrante(req.body ?? {});
  const provider = messagingProvider();

  for (const s of evento.statuses) {
    inc(`wa:status:${s.status}`);
    if (s.status === 'failed') {
      log.warn('whatsapp: mensaje saliente falló', { waMessageId: s.waMessageId, errorCode: s.errorCode });
      void marcarFallidoPorWamid(s.waMessageId).catch(() => {}); // recordatorio no entregado (F9)
    }
  }

  for (const msg of evento.messages) {
    if (pubsubHabilitado()) {
      // Split webhook/worker (F11): el webhook solo publica; el worker procesa (POST /pubsub/turnos).
      // Si el publish falla, se degrada al despacho local: perder el orden es mejor que perder el turno.
      void publicarTurno(msg).then((r) => {
        if (r.ok) return inc('pubsub:publicado');
        inc('errors:pubsub_publish');
        log.warn('whatsapp: publish falló — despacho local de respaldo');
        return despacharMensaje(msg, provider, requestId);
      }).catch((e) => log.error('whatsapp: error publicando turno', { err: String(e) }));
    } else {
      void despacharMensaje(msg, provider, requestId).catch((e) =>
        log.error('whatsapp: error procesando mensaje', { err: String(e) }),
      );
    }
  }
}

/** Despacha UN mensaje con las garantías del pipeline: lock distribuido por conversación,
 *  semáforo por instancia y correlación de logs. Lo usan el modo in-process y el worker Pub/Sub. */
export async function despacharMensaje(msg: InboundMessage, provider: MessagingProvider, requestId = '-'): Promise<void> {
  await withKeyedLock(msg.from || 'sin-remitente', () =>
    turnLimit(() =>
      runWithRequestContext({ requestId, dialogId: msg.from }, () => procesarMensajeEntrante(msg, provider)),
    ),
  );
}

/** Convierte un mensaje entrante en el contenido del turno para el motor (texto o bloques con imagen).
 *  Devuelve null si el mensaje no amerita turno (sin contenido procesable). */
async function contenidoDelTurno(
  msg: InboundMessage,
  provider: MessagingProvider,
): Promise<string | any[] | null> {
  switch (msg.type) {
    case 'text':
      return msg.text?.trim() || null;

    case 'interactive': {
      // La respuesta a botones/listas llega con id+título; para el motor es el texto elegido.
      // (En Fase 7, el flujo de evaluaciones interceptará interactiveReplyId ANTES de llegar aquí.)
      return msg.interactiveReplyTitle?.trim() || msg.interactiveReplyId || null;
    }

    case 'audio': {
      if (!msg.mediaId) return null;
      const media = await provider.descargarMedia(msg.mediaId);
      const transcrito = media ? await transcribeAudio(media.base64, media.mediaType) : null;
      if (transcrito?.trim()) return transcrito.trim();
      return '(el estudiante envió un audio que no se pudo transcribir; pídele amablemente que escriba su consulta)';
    }

    case 'image': {
      if (!msg.mediaId) return null;
      const media = await provider.descargarMedia(msg.mediaId);
      if (!media) return msg.text?.trim() || null;
      return [
        {
          type: 'text',
          text:
            msg.text?.trim() ||
            'El estudiante envió una imagen sin texto. Interprétala y responde su consulta (puede ser un ejercicio, un apunte o una captura del curso).',
        },
        { type: 'image', source: { type: 'base64', media_type: media.mediaType, data: media.base64 } },
      ];
    }

    case 'document': {
      const nombre = msg.filename ?? 'sin nombre';
      const caption = msg.text?.trim() ? ` Su comentario junto al archivo: "${msg.text.trim()}".` : '';
      return `(el estudiante envió el archivo "${nombre}" que no puedo abrir por este medio.${caption} Pídele que te cuente por texto qué necesita)`;
    }

    default:
      return null;
  }
}

/** Procesa UN mensaje entrante: dedupe → contenido → turno del motor → respuesta. Exportada para tests. */
export async function procesarMensajeEntrante(msg: InboundMessage, provider: MessagingProvider): Promise<void> {
  if (!msg.from || !msg.waMessageId) return;

  // GUARDA DE NÚMERO PROPIO. El webhook de Meta se configura por APP, no por número: una app
  // suscrita a varias cuentas de WhatsApp Business recibe el tráfico de TODAS. Sin esta
  // verificación, este servicio atendería conversaciones de un número productivo ajeno al piloto —
  // le respondería a alguien que escribió buscando otra cosa, y le crearía una ficha de estudiante.
  // Se ignora en silencio (Meta ya recibió su 200) y se deja rastro para poder detectarlo.
  if (config.waCloudPhoneNumberId && msg.aPhoneNumberId && msg.aPhoneNumberId !== config.waCloudPhoneNumberId) {
    inc('inbound:numero_ajeno');
    return log.warn('whatsapp: mensaje dirigido a OTRO número, ignorado', {
      esperado: config.waCloudPhoneNumberId,
      recibido: msg.aPhoneNumberId,
    });
  }

  // Idempotencia: Meta reintenta el webhook hasta 7 días → el TTL del dedupe debe cubrir toda esa
  // ventana con margen (revisión F9.1: 24h dejaba pasar reintentos tardíos como mensajes nuevos).
  if (!(await once(`wa:msg:${msg.waMessageId}`, 8 * 24 * 3600))) {
    return log.info('whatsapp: mensaje duplicado ignorado', { waMessageId: msg.waMessageId });
  }
  inc('inbound');

  // Ventana de servicio de 24h de WhatsApp: registrar la última entrada del estudiante permite a
  // los recordatorios (F9) elegir texto libre (gratis) vs plantilla utility.
  void setJson(`ult_in:${msg.from}`, { t: Date.now() }, 25 * 3600).catch(() => {});

  // Convocatoria: este número escribió. Si estaba en la cola de invitaciones sale de ella, venga del
  // QR o de la plantilla — así no se le paga una invitación a quien ya llegó. Best-effort.
  void marcarRespondio(msg.from).catch(() => {});

  // Marcar como leído (check azul) — mejora la experiencia; no crítico.
  void provider.marcarLeido(msg.waMessageId).catch(() => {});

  // Registro de identidad (F3): asistente determinista para usuarios sin Persona. Si consume el
  // mensaje (pregunta/valida/persiste), el motor no corre. Sin BD (dev) se omite limpiamente.
  const registro = await manejarRegistro(msg, provider);
  if (registro.handled) return;
  const persona = registro.persona ?? null;

  // Opt-out / opt-in de recordatorios (F9): efectivo e inmediato. El opt-out se evalúa PRIMERO
  // ("no quiero recordatorios" contiene "quiero recordatorios"). Solo se confirma lo que realmente
  // se persistió (revisión F9.1) — obligación de Meta y de la Ley 21.719.
  if (persona && msg.type === 'text' && esOptOutRecordatorios(msg.text ?? '')) {
    const persistido = await registrarOptOut(persona.id, CONSENT_VERSION);
    await cancelarDePersona(persona.id);
    await provider.enviarTexto(
      msg.from,
      persistido
        ? 'Listo ✅ No te enviaré más recordatorios. Puedes reactivarlos cuando quieras diciéndome "quiero recordatorios". Tu curso sigue disponible: escribe *continuar* cuando gustes.'
        : 'No pude registrar tu solicitud en este momento 😕 Inténtalo de nuevo en unos minutos, por favor.',
    );
    if (persistido) void audit({ type: 'optout_recordatorios', dialogId: msg.from });
    return;
  }
  if (persona && msg.type === 'text' && esOptInRecordatorios(msg.text ?? '')) {
    const persistido = await registrarOptIn(persona.id, CONSENT_VERSION);
    await provider.enviarTexto(
      msg.from,
      persistido
        ? '¡Listo! ✅ Recordatorios reactivados. Te avisaré cuando tengas algo pendiente del curso 🙂'
        : 'No pude registrar el cambio en este momento 😕 Inténtalo de nuevo en unos minutos, por favor.',
    );
    if (persistido) void audit({ type: 'optin_recordatorios', dialogId: msg.from });
    return;
  }

  // Evaluaciones formativas (F7): interceptor determinista de respuestas de quiz (botones/listas o
  // texto A-D/V-F) ANTES del motor — el parsing y el registro académico jamás se delegan al LLM.
  const evaluacion = await manejarEvaluacion(msg, persona, provider);
  if (evaluacion.handled) return;

  // Certificación (F8): interceptor determinista — RUT, verificación de correo y emisión jamás
  // pasan por el LLM.
  const certificacion = await manejarCertificacion(msg, persona, provider);
  if (certificacion.handled) return;

  const t0 = Date.now();
  const contenido = await contenidoDelTurno(msg, provider);
  if (!contenido) return log.info('whatsapp: mensaje sin contenido procesable (ignorado)', { tipo: msg.type });

  // Rehidratación académica (F4): al abrir conversación, el tutor recibe desde Postgres quién es el
  // estudiante y dónde quedó (curso, avance, próxima microcápsula) — nunca desde el historial del LLM.
  // Solo se inyecta si la memoria conversacional está vacía (ver agentLoop/priorContextMessage).
  const priorContext = persona
    ? await contextoAcademico(persona.id, [persona.nombre, persona.apellido].filter(Boolean).join(' ') || null)
    : '';

  const reply = await runAgentTurn(
    { profile: TUTOR_WHATSAPP_PROFILE, conversationId: msg.from, personId: persona?.id },
    contenido,
    priorContext,
  );

  const enviado = await provider.enviarTexto(msg.from, reply);
  if (enviado.ok) inc('reply');
  else if (enviado.skipped) log.warn('whatsapp: respuesta no enviada (proveedor sin configurar — solo dev)');
  else {
    inc('errors:send');
    log.error('whatsapp: fallo al enviar la respuesta', { error: enviado.error });
  }

  // Auditoría MINIMIZADA: metadatos del turno, nunca el texto completo (política de Fase 1).
  await audit({
    type: 'turn',
    dialogId: msg.from,
    detail: { tipo: msg.type, inLen: typeof contenido === 'string' ? contenido.length : -1, outLen: reply.length, responseMs: Date.now() - t0, enviado: enviado.ok },
  });
}
