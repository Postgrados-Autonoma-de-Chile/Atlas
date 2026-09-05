import { redactPII } from './obs/redact';
import { getRequestContext } from './obs/requestContext';

type Meta = Record<string, unknown>;
type Nivel = 'info' | 'warn' | 'error';

// Redacción de PII (email/teléfono/RUT): en PRODUCCIÓN es INCONDICIONAL (F12); LOG_REDACT=off
// solo surte efecto en desarrollo.
const REDACT = process.env.NODE_ENV === 'production' || process.env.LOG_REDACT !== 'off';

// Formato (F13): JSON estructurado para Cloud Logging (parsea `severity`/`message` nativamente
// desde stdout) en producción; texto de una línea en desarrollo. Forzable con LOG_FORMAT=json|text.
export function resolverFormato(env: { LOG_FORMAT?: string; NODE_ENV?: string }): 'json' | 'text' {
  if (env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'text') return env.LOG_FORMAT;
  return env.NODE_ENV === 'production' ? 'json' : 'text';
}
const FORMATO = resolverFormato(process.env);

const SEVERIDAD: Record<Nivel, string> = { info: 'INFO', warn: 'WARNING', error: 'ERROR' };

/** Construye la línea de log (pura, testeable). meta ya viene redactada. */
export function formatearLinea(formato: 'json' | 'text', nivel: Nivel, msg: string, meta: Meta): string {
  if (formato === 'json') {
    return JSON.stringify({ severity: SEVERIDAD[nivel], message: msg, ...meta, time: new Date().toISOString() });
  }
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${nivel.toUpperCase()} ${msg}${extra}`;
}

function emit(nivel: Nivel, msg: string, meta?: Meta) {
  // Correlación: adjunta reqId (y dialogId, si aplica) del contexto de la petición.
  const ctx = getRequestContext();
  const merged: Meta = {};
  if (ctx) {
    merged.reqId = ctx.requestId;
    if (ctx.dialogId) merged.dialogId = ctx.dialogId;
  }
  Object.assign(merged, meta ?? {});
  const safe = REDACT ? (redactPII(merged) as Meta) : merged;
  console.log(formatearLinea(FORMATO, nivel, REDACT ? (redactPII(msg) as string) : msg, safe));
}

export const log = {
  info: (m: string, meta?: Meta) => emit('info', m, meta),
  warn: (m: string, meta?: Meta) => emit('warn', m, meta),
  error: (m: string, meta?: Meta) => emit('error', m, meta),
};
