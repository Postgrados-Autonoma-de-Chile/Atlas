// Redacción de PII reutilizable para logs y auditoría (email, teléfono y — desde F12 — RUT).
// Enmascara los valores dentro de strings a cualquier profundidad, preservando la estructura
// (para no romper la analítica que agrega por campos no sensibles como score/tipo/orden).

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_INTL_RE = /\+\d{8,15}\b/g; // E.164 con prefijo +
const PHONE_CL_RE = /\b(?:56)?9\d{8}\b/g; // móvil chileno sin +
// RUT chileno (F12): con puntos y/o guion (12.345.678-5, 12345678-5) o pegado con dv K (12345670K).
// El caso "9 dígitos sin separador" que podría ser RUT ya cae bajo PHONE_CL_RE cuando empieza en 9;
// el resto de dígitos corridos sin dv no es identificable como RUT sin falsos positivos masivos.
const RUT_RE = /\b\d{1,2}(?:\.?\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b|\b\d{7,8}[kK]\b/g;

export function redactPII(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replace(EMAIL_RE, '[email]')
      .replace(RUT_RE, '[rut]')
      .replace(PHONE_INTL_RE, '[tel]')
      .replace(PHONE_CL_RE, '[tel]');
  }
  if (Array.isArray(v)) return v.map(redactPII);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactPII(x)]));
  }
  return v;
}
