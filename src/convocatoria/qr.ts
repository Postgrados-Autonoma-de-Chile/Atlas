// Entrada por QR / enlace: la vía por la que un estudiante llega SIN que se pague nada.
//
// Es la pieza más rentable de toda la convocatoria y su código es trivial. La razón está en el
// modelo de cobro de WhatsApp: una conversación que INICIA el estudiante es gratis y no consume el
// tramo de mensajería de Meta. Una plantilla que inicia el negocio se paga y sí lo consume.
//
// El truco está en el texto precargado: `wa.me/<numero>?text=<mensaje>` abre WhatsApp con el mensaje
// ya escrito, así que la persona solo aprieta enviar. Ese primer mensaje es lo que abre la ventana de
// servicio de 24 h y deja al tutor conversando gratis.
//
// El texto además debe calzar con el flujo de registro: uno explícito ("quiero inscribirme en el
// curso") hace que el asistente de identidad arranque de inmediato, sin gastar un turno preguntando
// a qué vino la persona.

/** Deja el número como lo quiere wa.me: solo dígitos, sin '+' ni separadores. PURA. */
export function numeroParaWaMe(numero: string): string {
  return String(numero ?? '').replace(/\D/g, '');
}

/**
 * Enlace de entrada. Devuelve null si el número no sirve — es preferible no generar un QR que
 * imprimir mil afiches con un enlace roto.
 */
export function linkWaMe(numero: string, texto: string): string | null {
  const n = numeroParaWaMe(numero);
  if (n.length < 8) return null;
  const t = String(texto ?? '').trim();
  return t ? `https://wa.me/${n}?text=${encodeURIComponent(t)}` : `https://wa.me/${n}`;
}
