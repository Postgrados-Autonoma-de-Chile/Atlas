import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { log } from '../log';
import { safeEqual } from '../util/crypto';
import { normalizarEntrante } from '../messaging';

// Webhook de WhatsApp Cloud API (Meta). En Fase 1 solo existen las piezas comunes de Meta —
// heredadas y probadas del canal IG/Messenger anterior, idénticas para WhatsApp Cloud API:
//   - handshake GET de verificación (hub.challenge)
//   - verificación de firma X-Hub-Signature-256 (HMAC-SHA256 del body CRUDO con el App Secret)
// El receptor real de mensajes (entry[].changes[].value.messages[] + statuses[]) se construye en
// la Fase 10 junto al MessagingProvider; mientras tanto el POST responde 200 y registra el evento.

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

/** POST /webhooks/whatsapp — placeholder: ACK inmediato y registro del evento ya NORMALIZADO por la
 *  capa de mensajería (Fase 2). En Fase 10 este handler publica los turnos a Pub/Sub (con dedupe
 *  por wa_message_id) y los statuses actualizan recordatorios/mensajes. */
export function metaWebhook(req: Request, res: Response) {
  res.sendStatus(200);
  const evento = normalizarEntrante(req.body ?? {});
  log.info('webhook whatsapp recibido (procesamiento llega en Fase 10)', {
    messages: evento.messages.length,
    statuses: evento.statuses.length,
    tipos: evento.messages.map((m) => m.type),
  });
}
