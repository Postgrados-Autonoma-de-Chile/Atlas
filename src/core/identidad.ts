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

/**
 * Nombre/apellido: mínimo 2 caracteres, sin dígitos (spec §11), y —revisión F14, hallazgo en
 * producción— sin las señales de que lo que llegó no es un nombre sino una pregunta, un correo o
 * una frase completa.
 *
 * La spec original solo pedía "sin dígitos": en el piloto real eso dejó pasar "Hola, Cuál Sería
 * El Valor ? Necesito Saber El Valor" como nombre de una persona, un correo pegado dentro de la
 * respuesta ("Sara Fredes Hfredes@indap.cl Ahí Está El Apellido"), y una credencial profesional
 * ("Magister En Derecho Penal Y Procesal Penal Urbina Reyes"). Esas tres cosas quedaron
 * registradas así, y `certificacion.ts` imprime `persona.nombre`/`apellido` tal cual en el PDF del
 * certificado sin volver a preguntar — un nombre mal capturado hoy es un certificado mal impreso
 * mañana.
 *
 * No hay forma de detectar CUALQUIER texto que no sea un nombre (eso requeriría entender el
 * idioma, y "lo que puede ser determinista no se delega al modelo"); esto rechaza las señales
 * concretas que ya se vieron: un signo de interrogación, un correo, dos puntos, o más palabras de
 * las que un nombre o un apellido chileno razonablemente tiene (tope generoso: 5, para no romper
 * a quien responde con nombre y los dos apellidos juntos).
 */
export function validarNombre(raw: string): boolean {
  const v = String(raw ?? '').trim();
  if (v.length < 2 || v.length > 80) return false;
  if (/\d/.test(v)) return false;
  if (/[?¿@:]/.test(v)) return false;
  if (v.split(/\s+/).length > 5) return false;
  return true;
}

/** Minúsculas sin acentos, para comparar palabras sin que un acento cuente como diferencia. */
const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Quita del apellido crudo cualquier palabra que ya apareció en el nombre ya capturado.
 *
 * POR QUÉ EXISTE: el flujo pide el nombre y el apellido en dos mensajes separados (spec §11,
 * "un dato por mensaje"), pero en Chile es común decir el nombre completo —con los dos
 * apellidos— cuando preguntan "¿cuál es tu nombre?", y luego responder la pregunta de apellido
 * igual, por las dudas. El resultado en producción: "Gabriela Silva" + "Silva Arancibia" →
 * mostrado como "Gabriela Silva Silva Arancibia". Ninguno de los dos campos está mal escrito;
 * están simplemente duplicados entre sí.
 *
 * Esto es una limpieza MECÁNICA —solo quita una repetición literal, nunca inventa ni reordena—
 * y por diseño puede dejar el apellido vacío si la persona repitió TODO lo que ya había dado
 * (p. ej. nombre="Bessy Gallardo Prado", apellido="Gallardo Prado"). Eso es intencional: es
 * preferible volver a preguntar —capturarCampo() ya reintenta ante un valor inválido— a guardar
 * un apellido idéntico al nombre solo para tener "algo" ahí.
 */
export function quitarRepetidoDeNombre(nombreYaCapturado: string, apellidoCrudo: string): string {
  const yaVisto = new Set(plano(nombreYaCapturado ?? '').split(/\s+/).filter(Boolean));
  return String(apellidoCrudo ?? '')
    .trim()
    .split(/\s+/)
    .filter((palabra) => palabra && !yaVisto.has(plano(palabra)))
    .join(' ');
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
