import { config } from '../config';
import { log } from '../log';
import { inc } from '../obs/metrics';
import { kvGet, kvSet } from '../store/kv';
import type {
  BotonOpcion,
  InboundEvent,
  InboundMessage,
  ListaOpcion,
  MessagingProvider,
  SendResult,
} from './types';

// Adaptador del BSP Chattigo. Implementa la MISMA interfaz que metaCloud: el motor, el tutor y los
// flujos deterministas no saben cuál está activo. Se elige con WA_PROVIDER.
//
// Documentación: https://development.chattigo.com/docs/api-bot/
//
// DIFERENCIAS DE FONDO CON CLOUD API DIRECTO — están documentadas en cada método, pero conviene
// tenerlas juntas porque cambian lo que el piloto puede hacer:
//
//   1. El webhook entrante NO viene firmado. Meta firma con HMAC-SHA256 y lo verificamos; Chattigo
//      solo hace POST y espera un 200. La barrera la ponemos nosotros (ver verificarTokenChattigo).
//   2. No documenta envío de plantillas HSM. Sin eso NO se puede iniciar conversación: el motor de
//      convocatoria por oleadas queda inoperante y solo se atiende a quien escriba primero.
//   3. No notifica estados (enviado/entregado/leído/fallido). Perdemos esas métricas.
//   4. No hay acuse de lectura.
//   5. Los adjuntos entrantes llegan como URL descargable, no como id de media.

const TTL_TOKEN_SEG = 7 * 60 * 60; // el JWT dura 8 h; se renueva una hora antes
const CLAVE_TOKEN = 'chattigo:jwt';
const TIMEOUT_MS = 10_000;

/** Chattigo trabaja con el número SIN '+'; nuestro dominio usa E.164 CON '+'. */
const aMsisdn = (e164: string) => String(e164 ?? '').replace(/^\+/, '');
const aE164 = (msisdn: string) => {
  const limpio = String(msisdn ?? '').replace(/[^\d]/g, '');
  return limpio ? `+${limpio}` : '';
};

// ── Autenticación ───────────────────────────────────────────────────────────────────────────────

/**
 * JWT de Chattigo, cacheado en el KV compartido.
 *
 * Dura 8 h y es por usuario. Guardarlo en Redis y no en memoria del proceso importa: con varias
 * instancias, cada una pidiendo el suyo, se multiplican los logins contra Chattigo — y como el token
 * es por usuario, un login nuevo puede invalidar el anterior y dejar a las otras instancias fuera.
 */
async function obtenerToken(forzar = false): Promise<string | null> {
  if (!forzar) {
    const cacheado = await kvGet(CLAVE_TOKEN);
    if (cacheado) return cacheado;
  }
  try {
    const r = await fetch(`${config.chattigoBaseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: config.chattigoUser, password: config.chattigoPass }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const cuerpo: any = await r.json().catch(() => ({}));
    const token = cuerpo?.access_token;
    if (!r.ok || !token) {
      inc('errors:chattigo_login');
      log.error('chattigo: login falló', { status: r.status, detalle: String(cuerpo?.message ?? '').slice(0, 120) });
      return null;
    }
    await kvSet(CLAVE_TOKEN, token, TTL_TOKEN_SEG);
    log.info('chattigo: token renovado');
    return token;
  } catch (e) {
    inc('errors:chattigo_login');
    log.error('chattigo: error de red en login', { err: String(e) });
    return null;
  }
}

/**
 * POST a /outbound con reintento ÚNICO ante 401.
 *
 * El token puede vencer o ser invalidado por un login desde otra parte, y el fallo se ve recién al
 * enviar. Un solo reintento con token fresco: más sería enmascarar un problema de credenciales
 * detrás de una tormenta de logins.
 */
async function enviarOutbound(payload: Record<string, unknown>): Promise<SendResult> {
  if (!estaConfigurado()) return { ok: false, skipped: true };

  for (const intento of [1, 2]) {
    const token = await obtenerToken(intento === 2);
    if (!token) return { ok: false, error: 'sin token de Chattigo' };
    try {
      const r = await fetch(`${config.chattigoBaseUrl}/outbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status === 401 && intento === 1) {
        log.warn('chattigo: 401 al enviar, renuevo el token y reintento');
        continue;
      }
      const cuerpo: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        inc('errors:chattigo_envio');
        const detalle = String(cuerpo?.message ?? cuerpo?.error ?? r.statusText).slice(0, 160);
        log.warn('chattigo: envío falló', { status: r.status, detalle });
        return { ok: false, error: detalle };
      }
      return { ok: true, messageId: cuerpo?.id != null ? String(cuerpo.id) : undefined };
    } catch (e) {
      inc('errors:chattigo_envio');
      log.warn('chattigo: error de red al enviar', { err: String(e) });
      return { ok: false, error: String(e) };
    }
  }
  return { ok: false, error: 'chattigo: agotados los intentos' };
}

/** Campos que Chattigo espera en todo saliente, más allá del contenido. */
function sobre(to: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    did: config.chattigoDid,
    msisdn: aMsisdn(to),
    channel: 'WHATSAPP',
    name: config.chattigoBotName,
    idCampaign: config.chattigoIdCampaign,
    isAttachment: false,
    attachment: null,
    ...extra,
  };
}

/** Credenciales mínimas para poder enviar. Puro y exportado para poder probarlo: `config` es un
 *  singleton que se evalúa una sola vez, así que una prueba no puede cambiarlo por variables de
 *  entorno — si esta lógica viviera dentro de estaConfigurado(), la prueba pasaría sin ejercitarla. */
export function credencialesCompletas(c: {
  waProvider: string; chattigoBaseUrl: string; chattigoUser: string; chattigoPass: string; chattigoDid: string;
}): boolean {
  return c.waProvider === 'chattigo' &&
    Boolean(c.chattigoBaseUrl && c.chattigoUser && c.chattigoPass && c.chattigoDid);
}

function estaConfigurado(): boolean {
  return credencialesCompletas(config);
}

// ── Entrante ────────────────────────────────────────────────────────────────────────────────────

/**
 * Autentica el webhook entrante con un secreto compartido.
 *
 * Chattigo NO firma sus webhooks —a diferencia de Meta, que usa HMAC-SHA256 sobre el cuerpo— así que
 * esta es la ÚNICA barrera. Sin ella, quien descubra la URL puede inyectar mensajes en nombre de
 * cualquier estudiante: alterar su progreso, o disparar la emisión de un certificado a su nombre.
 *
 * Se acepta por header (preferible) o por segmento de ruta, porque no todos los BSP permiten
 * configurar headers personalizados en el webhook. La comparación es de tiempo constante.
 *
 * Fail-closed: sin token configurado NO se acepta nada. Un webhook abierto es peor que uno caído.
 */
export function secretoCoincide(recibido: string | undefined, esperado: string): boolean {
  if (!esperado) return false; // fail-closed: sin secreto configurado no se acepta NADA
  const a = Buffer.from(String(recibido ?? ''));
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a[i] ^ b[i];
  return dif === 0;
}

export function verificarTokenChattigo(recibido: string | undefined): boolean {
  return secretoCoincide(recibido, config.chattigoWebhookToken);
}

/** Tipos de Chattigo que NO son un turno del estudiante y no deben llegar al motor. */
const TIPOS_DE_SISTEMA = new Set(['transfer', 'group', 'close', 'timeout']);

/**
 * Normaliza el webhook de Chattigo al InboundMessage del dominio.
 *
 * Chattigo manda UN mensaje por POST (Meta manda lotes), así que el arreglo trae 0 o 1 elemento.
 * `statuses` va siempre vacío: Chattigo no notifica estados de entrega.
 */
export function normalizarEntranteChattigo(body: any): InboundEvent {
  const messages: InboundMessage[] = [];
  if (!body || typeof body !== 'object') return { messages, statuses: [] };

  const tipoCrudo = String(body.type ?? '').toLowerCase();
  if (TIPOS_DE_SISTEMA.has(tipoCrudo)) {
    log.info('chattigo: evento de sistema ignorado', { tipo: tipoCrudo });
    return { messages, statuses: [] };
  }

  const from = aE164(body.msisdn);
  // El id es NUMÉRICO en Chattigo; la idempotencia lo trata como texto. Se prefija para que no pueda
  // colisionar con un wamid de Meta si algún día conviven durante una migración de número.
  const id = body.id != null ? `chattigo:${body.id}` : '';
  if (!from || !id) {
    log.warn('chattigo: mensaje sin remitente o sin id, descartado');
    return { messages, statuses: [] };
  }

  const attachment = body.attachment ?? null;
  const esAdjunto = Boolean(body.isAttachment) && attachment?.mediaUrl;
  const mime = String(attachment?.mimeType ?? '');

  let type: InboundMessage['type'] = 'unknown';
  if (esAdjunto) {
    if (mime.startsWith('audio/')) type = 'audio';
    else if (mime.startsWith('image/')) type = 'image';
    else type = 'document';
  } else if (body.interactiveChoiceId) {
    type = 'interactive';
  } else if (tipoCrudo === 'text' && body.content) {
    type = 'text';
  }

  messages.push({
    waMessageId: id,
    from,
    // `did` es el número AL QUE llegó: el equivalente de phone_number_id en Meta. La guarda de
    // número propio compara contra él igual que en Cloud API.
    aPhoneNumberId: body.did != null ? String(body.did) : undefined,
    timestamp: new Date(),
    type,
    text: body.content != null ? String(body.content) : undefined,
    interactiveReplyId: body.interactiveChoiceId != null ? String(body.interactiveChoiceId) : undefined,
    interactiveReplyTitle: body.interactiveChoiceText != null ? String(body.interactiveChoiceText) : undefined,
    // No hay id de media: el adjunto viene como URL. Se guarda ahí y descargarMedia() la resuelve.
    mediaId: esAdjunto ? String(attachment.mediaUrl) : undefined,
    filename: attachment?.fileName != null ? String(attachment.fileName) : undefined,
  });

  return { messages, statuses: [] };
}

// ── Provider ────────────────────────────────────────────────────────────────────────────────────

export const chattigoProvider: MessagingProvider = {
  nombre: 'chattigo',
  configurado: estaConfigurado,

  async enviarTexto(to, texto) {
    return enviarOutbound(sobre(to, { type: 'text', content: texto }));
  },

  /**
   * NO IMPLEMENTADO: Chattigo no documenta el envío de plantillas HSM. Su único endpoint de HSM
   * (GET /messages/...) sirve para LEER mensajes que el bot no procesó, no para enviar.
   *
   * Consecuencia concreta: con este proveedor NO se puede iniciar una conversación. El motor de
   * convocatoria por oleadas queda inoperante y el piloto solo puede atender a quien escriba
   * primero. Devuelve un fallo explícito en vez de fingir éxito, para que quede en las métricas y
   * no se descubra cuando falten los avisos.
   */
  async enviarPlantilla(_to, plantilla, _lang, _params) {
    inc('errors:chattigo_plantilla_no_soportada');
    log.error('chattigo: envío de plantilla HSM no soportado por el proveedor', { plantilla });
    return { ok: false, error: 'chattigo: plantillas HSM no soportadas (ver docs/CHATTIGO.md)' };
  },

  /**
   * Los botones se envían como LISTA de opciones.
   *
   * Chattigo documenta `cta_url` (un botón que abre una URL) y `list` (opciones seleccionables). Lo
   * que ATLAS necesita —que la persona elija y nos llegue el id— es lo segundo: la elección vuelve
   * en `interactiveChoiceId`, que es justo nuestro interactiveReplyId. `cta_url` no sirve porque no
   * devuelve una elección, se va del chat.
   *
   * Diferencia visible para el estudiante: en vez de hasta 3 botones bajo el mensaje, ve un botón
   * que abre una lista. Un toque más para responder un verdadero/falso.
   */
  async enviarBotones(to, cuerpo, botones: BotonOpcion[]) {
    return enviarOutbound(
      sobre(to, {
        type: 'text',
        content: cuerpo,
        botProvider: 'CHATTIGO',
        interactiveMsg: {
          interactiveType: 'list',
          body: cuerpo,
          titleList: 'Responder',
          choices: botones.slice(0, 3).map((b) => ({ id: b.id, text: b.titulo })),
        },
      }),
    );
  },

  async enviarLista(to, cuerpo, textoBoton, opciones: ListaOpcion[]) {
    return enviarOutbound(
      sobre(to, {
        type: 'text',
        content: cuerpo,
        botProvider: 'CHATTIGO',
        interactiveMsg: {
          interactiveType: 'list',
          body: cuerpo,
          titleList: textoBoton,
          choices: opciones.slice(0, 10).map((o) => ({ id: o.id, text: o.titulo })),
        },
      }),
    );
  },

  /** El adjunto va por URL PÚBLICA: Chattigo no recibe binarios ni ids de media. */
  async enviarDocumento(to, urlOMediaId, filename, caption) {
    if (!/^https?:\/\//i.test(urlOMediaId)) {
      log.error('chattigo: enviarDocumento exige una URL pública, no un id de media', { filename });
      return { ok: false, error: 'chattigo: se requiere URL pública del documento' };
    }
    return enviarOutbound(
      sobre(to, {
        type: 'media',
        content: caption ?? '',
        isAttachment: true,
        attachment: { mediaUrl: urlOMediaId, mimeType: 'application/pdf', fileName: filename },
      }),
    );
  },

  /**
   * El "mediaId" que guardó normalizarEntranteChattigo es en realidad la URL del adjunto, porque
   * Chattigo no expone ids de media. Se descarga directo.
   */
  async descargarMedia(mediaId) {
    if (!/^https?:\/\//i.test(mediaId)) {
      log.warn('chattigo: descargarMedia esperaba una URL', { valor: mediaId.slice(0, 40) });
      return null;
    }
    try {
      const r = await fetch(mediaId, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) {
        log.warn('chattigo: no pude descargar el adjunto', { status: r.status });
        return null;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return { base64: buf.toString('base64'), mediaType: r.headers.get('content-type') ?? 'application/octet-stream' };
    } catch (e) {
      log.warn('chattigo: error de red descargando el adjunto', { err: String(e) });
      return null;
    }
  },

  /** Chattigo no expone acuse de lectura. Se omite en silencio: es cosmético (el doble check azul). */
  async marcarLeido(_waMessageId) {
    return { ok: false, skipped: true };
  },
};
