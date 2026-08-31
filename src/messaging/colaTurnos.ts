import { GoogleAuth } from 'google-auth-library';
import { config } from '../config';
import { log } from '../log';
import type { InboundMessage } from './types';

// Cola de turnos (Fase 11): el webhook publica cada mensaje entrante normalizado a Pub/Sub y el
// worker lo consume por push subscription. Cliente por REST + google-auth-library (ADC): sin gRPC
// en el bundle. Semántica at-least-once de Pub/Sub domesticada aguas abajo: dedupe por wamid
// (once) + UNIQUEs académicos; el ORDEN por estudiante lo da orderingKey = msg.from (el topic debe
// crearse con ordering habilitado — ver infra/main.tf) junto al lock por conversación del worker.

let auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!auth) auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/pubsub'] });
  return auth;
}

export function pubsubHabilitado(): boolean {
  return Boolean(config.pubsubTopic);
}

/** Mensaje de publish (puro, testeable): data en base64 con el timestamp serializado a ISO. */
export function construirMensajePubSub(msg: InboundMessage) {
  return {
    data: Buffer.from(JSON.stringify({ ...msg, timestamp: msg.timestamp.toISOString() }), 'utf8').toString('base64'),
    orderingKey: msg.from || 'sin-remitente',
    attributes: { tipo: msg.type },
  };
}

/** Decodifica el data (base64) de un envelope de push a InboundMessage. null si es malformado. */
export function decodificarTurno(dataB64: string): InboundMessage | null {
  try {
    const raw = JSON.parse(Buffer.from(String(dataB64 ?? ''), 'base64').toString('utf8'));
    if (typeof raw?.waMessageId !== 'string' || typeof raw?.from !== 'string' || typeof raw?.type !== 'string') return null;
    return { ...raw, timestamp: new Date(raw.timestamp ?? 0) } as InboundMessage;
  } catch {
    return null;
  }
}

export type ResultadoPublicacion = { ok: boolean; skipped?: boolean; error?: string };

/** Publica un turno al topic configurado. skipped=true si Pub/Sub no está habilitado. */
export async function publicarTurno(msg: InboundMessage): Promise<ResultadoPublicacion> {
  if (!pubsubHabilitado()) return { ok: false, skipped: true };
  try {
    const token = await getAuth().getAccessToken();
    const r = await fetch(`${config.pubsubEndpoint}/v1/${config.pubsubTopic}:publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [construirMensajePubSub(msg)] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const detalle = await r.text().catch(() => '');
      log.warn('pubsub: publish falló', { status: r.status, detalle: detalle.slice(0, 200) });
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    log.warn('pubsub: error publicando', { err: String(e) });
    return { ok: false, error: String(e) };
  }
}
