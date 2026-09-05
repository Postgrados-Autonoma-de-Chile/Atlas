// Capa de abstracción de mensajería de ATLAS (Fase 2).
// REGLA ARQUITECTÓNICA: nada fuera de src/messaging/ importa nada de Meta/Graph API. El tutor habla
// con esta interfaz; cambiar de proveedor (Cloud API directo → BSP Chattigo/Atom) es escribir otra
// implementación y migrar el número, sin tocar el motor ni el dominio educativo.

export type SendResult = {
  ok: boolean;
  /** Id del mensaje asignado por el proveedor (wamid en Meta) — clave para correlacionar statuses. */
  messageId?: string;
  error?: string;
  /** true = el proveedor no está configurado (dev): la operación se omite sin tocar la red. */
  skipped?: boolean;
};

/** Mensaje entrante normalizado (independiente del proveedor). */
export type InboundMessage = {
  /** Id único del mensaje en el proveedor (wamid) — base de la idempotencia. */
  waMessageId: string;
  /** Teléfono del estudiante normalizado a E.164 con '+'. */
  from: string;
  /** phone_number_id AL QUE llegó el mensaje (metadata del webhook). Un webhook de Meta se
   *  configura por APP, así que una app suscrita a varias cuentas recibe el tráfico de TODAS: sin
   *  este dato el servicio no puede distinguir su propio número del de otro. */
  aPhoneNumberId?: string;
  timestamp: Date;
  type: 'text' | 'interactive' | 'audio' | 'image' | 'document' | 'unknown';
  /** Texto del mensaje (type=text) o caption si lo hubiera. */
  text?: string;
  /** Id de la opción elegida en un mensaje interactivo (botón o fila de lista). */
  interactiveReplyId?: string;
  /** Título visible de la opción elegida. */
  interactiveReplyTitle?: string;
  /** Id de media para descargar audio/imagen/documento vía descargarMedia(). */
  mediaId?: string;
  /** Nombre del archivo (type=document) — separado del caption, que va en text. */
  filename?: string;
};

/** Evento de estado de un mensaje saliente (sent/delivered/read/failed). */
export type InboundStatus = {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  /** Teléfono del destinatario (E.164 con '+'). */
  recipient: string;
  errorCode?: string;
};

/** Resultado de normalizar el body de un webhook del proveedor. */
export type InboundEvent = {
  messages: InboundMessage[];
  statuses: InboundStatus[];
};

export type BotonOpcion = { id: string; titulo: string };
export type ListaOpcion = { id: string; titulo: string; descripcion?: string };

export interface MessagingProvider {
  readonly nombre: string;
  /** true si hay credenciales para enviar; si no, todos los envíos devuelven {skipped:true}. */
  configurado(): boolean;

  /** Texto libre — solo válido dentro de la ventana de servicio de 24h (gratis). */
  enviarTexto(to: string, texto: string): Promise<SendResult>;
  /** Plantilla pre-aprobada — único mensaje permitido fuera de la ventana de 24h. */
  enviarPlantilla(to: string, plantilla: string, lang: string, params: string[]): Promise<SendResult>;
  /** Botones (máx. 3) — para evaluaciones V/F y confirmaciones. Respuesta llega como interactiveReplyId. */
  enviarBotones(to: string, cuerpo: string, botones: BotonOpcion[]): Promise<SendResult>;
  /** Lista (máx. 10 filas) — para selección múltiple A-D. */
  enviarLista(to: string, cuerpo: string, textoBoton: string, opciones: ListaOpcion[]): Promise<SendResult>;
  /** Documento (PDF de certificado, material) por URL pública o media id. */
  enviarDocumento(to: string, urlOMediaId: string, filename: string, caption?: string): Promise<SendResult>;

  /** Descarga un media entrante (audio/imagen/documento) → base64 + mime, o null si falla. */
  descargarMedia(mediaId: string): Promise<{ base64: string; mediaType: string } | null>;

  /** Marca un mensaje entrante como leído (check azul). Best-effort: nunca lanza. */
  marcarLeido(waMessageId: string): Promise<SendResult>;
}
