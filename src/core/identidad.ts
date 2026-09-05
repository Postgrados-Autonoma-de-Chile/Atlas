import crypto from 'crypto';

// Validadores PUROS de identidad (Fase 3), según docs/specs/captura-identidad-estudiante.md.
// Deterministas y testeables: la validación de datos personales NUNCA se delega al LLM.

/** Normaliza un RUT a formato canónico NNNNNNNN-D (sin puntos, guion, K mayúscula). '' si no parsea.
 *  Acepta la escritura sin guion ("123456785", "12345670K"): el último carácter se toma como dígito
 *  verificador — el módulo 11 de validarRut() es quien decide si la interpretación es correcta. */
export function normalizarRut(raw: string): string {
  const limpio = String(raw ?? '').trim().toUpperCase().replace(/\./g, '').replace(/\s/g, '');
  const m = limpio.match(/^(\d{7,8})-?([\dK])$/);
  return m ? `${m[1]}-${m[2]}` : '';
}

/** Valida el dígito verificador chileno (módulo 11). Acepta con/sin puntos y guion. */
export function validarRut(raw: string): boolean {
  const rut = normalizarRut(raw);
  if (!rut) return false;
  const [cuerpo, dv] = rut.split('-');
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  return dv === esperado;
}

/** Email razonable (RFC-lite): usuario@dominio.tld sin espacios. La verificación real es por código (F8). */
export function validarEmail(raw: string): boolean {
  const email = String(raw ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export function normalizarEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

/** Nombre/apellido: mínimo 2 caracteres, sin dígitos (spec §11). */
export function validarNombre(raw: string): boolean {
  const v = String(raw ?? '').trim();
  return v.length >= 2 && v.length <= 80 && !/\d/.test(v);
}

/** Capitaliza de forma simple para saludar ("rodrigo" → "Rodrigo"). */
export function capitalizar(raw: string): string {
  return String(raw ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** Hash de lookup (SHA-256 hex) para unicidad/búsqueda de email y RUT sin guardarlos en claro. */
export function hashLookup(valorNormalizado: string): string {
  return crypto.createHash('sha256').update(valorNormalizado, 'utf8').digest('hex');
}
