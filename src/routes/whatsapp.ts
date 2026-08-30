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
import type { InboundMessage, MessagingProvider } from '../messaging';

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
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'META_APP_SECRET no configurado' });
    }
    log.warn('verifyMetaSignature: sin META_APP_SECRET (fail-open solo en desarrollo)');
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
    if (s.status === 'failed') log.warn('whatsapp: mensaje saliente falló', { waMessageId: s.waMessageId, errorCode: s.errorCode });
  }

  for (const msg of evento.messages) {
    void withKeyedLock(msg.from || 'sin-remitente', () =>
      turnLimit(() =>
        runWithRequestContext({ requestId, dialogId: msg.from }, () => procesarMensajeEntrante(msg, provider)),
      ),
    ).catch((e) => log.error('whatsapp: error procesando mensaje', { err: String(e) }));
  }
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

    case 'document':
      return `(el estudiante envió el archivo "${msg.text ?? 'sin nombre'}" que no puedo abrir por este medio; pídele que te cuente por texto qué necesita)`;

    default:
      return null;
  }
}

/** Procesa UN mensaje entrante: dedupe → contenido → turno del motor → respuesta. Exportada para tests. */
export async function procesarMensajeEntrante(msg: InboundMessage, provider: MessagingProvider): Promise<void> {
  if (!msg.from || !msg.waMessageId) return;

  // Idempotencia: Meta reintenta el webhook hasta 7 días; el mismo wamid solo se procesa una vez.
  if (!(await once(`wa:msg:${msg.waMessageId}`, 24 * 3600))) {
    return log.info('whatsapp: mensaje duplicado ignorado', { waMessageId: msg.waMessageId });
  }
  inc('inbound');

  // Marcar como leído (check azul) — mejora la experiencia; no crítico.
  void provider.marcarLeido(msg.waMessageId).catch(() => {});

  const t0 = Date.now();
  const contenido = await contenidoDelTurno(msg, provider);
  if (!contenido) return log.info('whatsapp: mensaje sin contenido procesable (ignorado)', { tipo: msg.type });

  const esNueva = false; // el conteo fino de conversaciones nuevas llega con identidad (F3)
  void esNueva;

  const reply = await runAgentTurn(
    { profile: TUTOR_WHATSAPP_PROFILE, conversationId: msg.from },
    contenido,
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
