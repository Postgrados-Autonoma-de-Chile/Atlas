import type { Request, Response } from 'express';
import { messagingProvider, normalizarEntranteChattigo, verificarTokenChattigo } from '../messaging';
import { encolarMensajes } from './whatsapp';
import { getRequestContext } from '../obs/requestContext';
import { inc } from '../obs/metrics';
import { config } from '../config';
import { log } from '../log';

// Webhook del BSP Chattigo. Entra por aquí lo que en Cloud API entra por /webhooks/whatsapp, y
// desemboca en el MISMO pipeline (encolarMensajes): lock por conversación, idempotencia y el resto.

/**
 * Autenticación del webhook.
 *
 * Chattigo NO firma sus webhooks. Meta manda X-Hub-Signature-256 con un HMAC del cuerpo y lo
 * verificamos en verifyMetaSignature; la documentación de Chattigo solo describe un POST a la URL
 * del cliente que debe responder 200 — sin firma, sin token, sin lista de IPs.
 *
 * Esta comprobación es entonces la única barrera. Sin ella, quien descubra la URL puede inyectar
 * mensajes en nombre de cualquier estudiante: alterar su progreso, o disparar la emisión de un
 * certificado a su nombre y hacerlo llegar a su correo.
 *
 * Se acepta el secreto por header `x-atlas-token` o como último segmento de la ruta, porque no todo
 * BSP permite configurar headers personalizados en el webhook. La ruta es el peor de los dos: queda
 * en los registros de cualquier proxy intermedio. Se prefiere el header y se acepta la ruta solo
 * como salida cuando Chattigo no ofrezca otra.
 *
 * Fail-closed: sin CHATTIGO_WEBHOOK_TOKEN configurado se rechaza TODO. Un webhook abierto que
 * escribe en el expediente académico de una persona es peor que uno caído.
 */
function autenticado(req: Request): boolean {
  const porHeader = req.header('x-atlas-token');
  if (porHeader && verificarTokenChattigo(porHeader)) return true;
  const porRuta = typeof req.params.token === 'string' ? req.params.token : undefined;
  return Boolean(porRuta && verificarTokenChattigo(porRuta));
}

export function chattigoWebhook(req: Request, res: Response) {
  if (!autenticado(req)) {
    inc('errors:chattigo_webhook_no_autenticado');
    log.warn('chattigo: webhook rechazado por token inválido o ausente');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // 200 inmediato: Chattigo solo espera el acuse. El procesamiento sigue en segundo plano, igual que
  // con Meta, para no retener la conexión mientras el modelo responde.
  res.sendStatus(200);

  const requestId = getRequestContext()?.requestId ?? '-';
  const evento = normalizarEntranteChattigo(req.body ?? {});

  // Chattigo no notifica estados de entrega (enviado/entregado/leído/fallido), así que
  // evento.statuses viene siempre vacío. Con este proveedor perdemos las métricas wa:status:* y la
  // detección de recordatorios no entregados que sí tenemos en Cloud API.
  if (!evento.messages.length) return;

  const provider = messagingProvider();
  if (provider.nombre !== 'chattigo') {
    // Llegó tráfico de Chattigo con otro proveedor activo: responder por Meta mandaría el mensaje
    // por un canal que no es el que lo originó.
    inc('errors:chattigo_proveedor_inactivo');
    return log.error('chattigo: webhook recibido pero WA_PROVIDER no es chattigo', {
      activo: provider.nombre,
      configurado: config.waProvider,
    });
  }

  encolarMensajes(evento.messages, provider, requestId);
}
