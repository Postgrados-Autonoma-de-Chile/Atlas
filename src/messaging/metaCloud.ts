import { config } from '../config';
import { log } from '../log';
import type {
  BotonOpcion, InboundEvent, InboundMessage, InboundStatus, ListaOpcion, MessagingProvider, SendResult,
} from './types';

// Implementación WhatsApp Cloud API (Meta Graph API) del MessagingProvider.
// Los constructores de payload son funciones PURAS (testeables sin red) — patrón heredado de
// construirPayloadMeta del sistema anterior, que se conserva y amplía. El bug del modo 'custom'
// (JSON armado por string-replace) desaparece: todo payload nace de JSON.stringify sobre objetos.

const MAX_MEDIA_BYTES = 12 * 1024 * 1024; // cap heredado de la ingesta anterior

/** Normaliza un wa_id/teléfono al formato E.164 con '+' (Meta entrega wa_id sin '+'). */
export function normalizarE164(waIdOTelefono: string): string {
  const digits = String(waIdOTelefono ?? '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : '';
}

/** Quita el '+' para el campo `to` de la Send API. */
const toMeta = (e164: string) => String(e164 ?? '').replace(/^\+/, '');

// ── Constructores de payload (puros) ──────────────────────────────────────────

export function payloadTexto(to: string, texto: string) {
  return { messaging_product: 'whatsapp', to: toMeta(to), type: 'text', text: { body: texto } };
}

export function payloadPlantilla(to: string, plantilla: string, lang: string, params: string[]) {
  const componentes = params.length
    ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
    : [];
  return {
    messaging_product: 'whatsapp',
    to: toMeta(to),
    type: 'template',
    template: { name: plantilla, language: { code: lang }, ...(componentes.length ? { components: componentes } : {}) },
  };
}

export function payloadBotones(to: string, cuerpo: string, botones: BotonOpcion[]) {
  return {
    messaging_product: 'whatsapp',
    to: toMeta(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: cuerpo },
      action: { buttons: botones.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.titulo } })) },
    },
  };
}

export function payloadLista(to: string, cuerpo: string, textoBoton: string, opciones: ListaOpcion[]) {
  return {
    messaging_product: 'whatsapp',
    to: toMeta(to),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: cuerpo },
      action: {
        button: textoBoton,
        sections: [{
          rows: opciones.slice(0, 10).map((o) => ({ id: o.id, title: o.titulo, ...(o.descripcion ? { description: o.descripcion } : {}) })),
        }],
      },
    },
  };
}

export function payloadDocumento(to: string, urlOMediaId: string, filename: string, caption?: string) {
  const esUrl = /^https?:\/\//i.test(urlOMediaId);
  return {
    messaging_product: 'whatsapp',
    to: toMeta(to),
    type: 'document',
    document: { ...(esUrl ? { link: urlOMediaId } : { id: urlOMediaId }), filename, ...(caption ? { caption } : {}) },
  };
}

// ── Normalización del webhook (pura) ──────────────────────────────────────────

/** Convierte el body crudo del webhook de Cloud API (entry[].changes[].value) al formato interno. */
export function normalizarEntrante(body: any): InboundEvent {
  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value || value.messaging_product !== 'whatsapp') continue;
      for (const m of value.messages ?? []) {
        const base = {
          waMessageId: String(m.id ?? ''),
          from: normalizarE164(m.from),
          timestamp: new Date(Number(m.timestamp ?? 0) * 1000),
        };
        if (m.type === 'text') {
          messages.push({ ...base, type: 'text', text: String(m.text?.body ?? '') });
        } else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          messages.push({
            ...base, type: 'interactive',
            interactiveReplyId: r?.id ? String(r.id) : undefined,
            interactiveReplyTitle: r?.title ? String(r.title) : undefined,
          });
        } else if (m.type === 'button') {
          // Respuesta a quick-reply de una PLANTILLA (p. ej. recordatorio): Cloud API la entrega
          // como type 'button', no 'interactive' (revisión F9.1) — normaliza al mismo formato.
          messages.push({
            ...base, type: 'interactive',
            interactiveReplyId: m.button?.payload ? String(m.button.payload) : undefined,
            interactiveReplyTitle: m.button?.text ? String(m.button.text) : undefined,
          });
        } else if (m.type === 'audio' || m.type === 'image' || m.type === 'document') {
          messages.push({
            ...base, type: m.type,
            mediaId: m[m.type]?.id ? String(m[m.type].id) : undefined,
            text: m[m.type]?.caption ? String(m[m.type].caption) : undefined,
            ...(m.type === 'document' && m.document?.filename ? { filename: String(m.document.filename) } : {}),
          });
        } else {
          messages.push({ ...base, type: 'unknown' });
        }
      }
      for (const s of value.statuses ?? []) {
        const st = String(s.status ?? '');
        if (st !== 'sent' && st !== 'delivered' && st !== 'read' && st !== 'failed') continue;
        statuses.push({
          waMessageId: String(s.id ?? ''),
          status: st,
          timestamp: new Date(Number(s.timestamp ?? 0) * 1000),
          recipient: normalizarE164(s.recipient_id),
          errorCode: s.errors?.[0]?.code != null ? String(s.errors[0].code) : undefined,
        });
      }
    }
  }
  return { messages, statuses };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class MetaCloudProvider implements MessagingProvider {
  readonly nombre = 'meta-cloud';

  configurado(): boolean {
    return config.waProvider === 'meta' && Boolean(config.waCloudPhoneNumberId && config.waCloudToken);
  }

  private async post(payload: unknown): Promise<SendResult> {
    if (!this.configurado()) {
      log.warn('messaging: proveedor no configurado — envío omitido (solo dev)');
      return { ok: false, skipped: true, error: 'proveedor_no_configurado' };
    }
    try {
      const url = `https://graph.facebook.com/${config.waGraphVersion}/${config.waCloudPhoneNumberId}/messages`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.waCloudToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const json: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detalle = json?.error?.message ?? `HTTP ${r.status}`;
        log.warn('messaging: envío falló', { status: r.status, detalle });
        return { ok: false, error: detalle };
      }
      return { ok: true, messageId: json?.messages?.[0]?.id };
    } catch (e) {
      log.warn('messaging: error de red al enviar', { err: String(e) });
      return { ok: false, error: String(e) };
    }
  }

  enviarTexto(to: string, texto: string) { return this.post(payloadTexto(to, texto)); }
  enviarPlantilla(to: string, plantilla: string, lang: string, params: string[]) {
    return this.post(payloadPlantilla(to, plantilla, lang, params));
  }
  enviarBotones(to: string, cuerpo: string, botones: BotonOpcion[]) { return this.post(payloadBotones(to, cuerpo, botones)); }
  enviarLista(to: string, cuerpo: string, textoBoton: string, opciones: ListaOpcion[]) {
    return this.post(payloadLista(to, cuerpo, textoBoton, opciones));
  }
  enviarDocumento(to: string, urlOMediaId: string, filename: string, caption?: string) {
    return this.post(payloadDocumento(to, urlOMediaId, filename, caption));
  }

  marcarLeido(waMessageId: string) {
    return this.post({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId });
  }

  /** Descarga en dos pasos de la Media API: GET /{media-id} → URL efímera → GET con Bearer. */
  async descargarMedia(mediaId: string): Promise<{ base64: string; mediaType: string } | null> {
    if (!this.configurado()) return null;
    try {
      const meta = await fetch(`https://graph.facebook.com/${config.waGraphVersion}/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${config.waCloudToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const info: any = await meta.json().catch(() => ({}));
      if (!meta.ok || !info?.url) return null;
      const bin = await fetch(info.url, {
        headers: { Authorization: `Bearer ${config.waCloudToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!bin.ok) return null;
      const buf = Buffer.from(await bin.arrayBuffer());
      if (buf.byteLength > MAX_MEDIA_BYTES) {
        log.warn('messaging: media supera el límite, descartado', { bytes: buf.byteLength });
        return null;
      }
      return { base64: buf.toString('base64'), mediaType: String(info.mime_type ?? 'application/octet-stream') };
    } catch (e) {
      log.warn('messaging: descargarMedia falló', { err: String(e) });
      return null;
    }
  }
}
