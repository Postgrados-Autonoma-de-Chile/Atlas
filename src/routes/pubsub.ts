import type { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { log } from '../log';
import { inc } from '../obs/metrics';
import { getRequestContext } from '../obs/requestContext';
import { decodificarTurno } from '../messaging/colaTurnos';
import { messagingProvider } from '../messaging';
import { despacharMensaje } from './whatsapp';

// Consumidor de la cola de turnos (Fase 11): Pub/Sub push → este endpoint (en el servicio worker).
// Auth: token OIDC que Pub/Sub firma con la service account de la suscripción — verificación
// FAIL-CLOSED (F12): sin PUBSUB_PUSH_SA configurada, el endpoint rechaza (salvo DEV_FAIL_OPEN).

const oidc = new OAuth2Client();

export function verifyPubSubPush(req: Request, res: Response, next: NextFunction) {
  if (!config.pubsubPushSa) {
    if (!config.devFailOpen) return res.status(503).json({ error: 'PUBSUB_PUSH_SA no configurada' });
    log.warn('pubsub push: sin PUBSUB_PUSH_SA (DEV_FAIL_OPEN activo — solo desarrollo)');
    return next();
  }
  const idToken = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!idToken) return res.status(401).json({ error: 'unauthorized' });
  oidc
    .verifyIdToken({ idToken, audience: config.pubsubPushAudience || undefined })
    .then((ticket) => {
      const p = ticket.getPayload();
      if (p?.email === config.pubsubPushSa && p?.email_verified) return next();
      res.status(401).json({ error: 'unauthorized' });
    })
    .catch(() => res.status(401).json({ error: 'unauthorized' }));
}

/**
 * POST /pubsub/turnos — procesa UN turno. Se responde 204 tras procesar (ack): el motor ya tiene
 * fallbacks internos y el dedupe por wamid haría inocuo un redelivery; un envelope malformado
 * también se ackea (la dead-letter queue existe para los reintentos agotados de entregas fallidas).
 */
export async function pubsubTurnos(req: Request, res: Response) {
  const data = req.body?.message?.data;
  const msg = data ? decodificarTurno(String(data)) : null;
  if (!msg) {
    inc('errors:pubsub_envelope');
    log.warn('pubsub push: envelope malformado (ack para no reintentar)', { messageId: req.body?.message?.messageId });
    return res.status(204).end();
  }
  const requestId = getRequestContext()?.requestId ?? '-';
  try {
    await despacharMensaje(msg, messagingProvider(), requestId);
  } catch (e) {
    log.error('pubsub push: error procesando turno', { err: String(e) });
  }
  res.status(204).end();
}
