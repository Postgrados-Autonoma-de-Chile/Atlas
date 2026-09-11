/* Un tipo más de recordatorio: 'primer_aviso'.
 *
 * POR QUÉ EXISTE: WhatsApp no cobra los mensajes enviados dentro de la ventana de servicio de 24 h
 * que abre el propio estudiante al escribir. Fuera de esa ventana hay que usar plantilla, y Meta
 * clasificó la nuestra como MARKETING —CLP 78,49 en vez de 17,66— porque un mensaje de "vuelve a tu
 * curso" es re-engagement por definición, sin importar cómo se redacte.
 *
 * El primer aviso se manda ANTES de que la ventana se cierre. No cuesta nada, no depende de cómo
 * Meta clasifique nada, y llega el mismo día — que además es cuando más probable es que la persona
 * retome. Los avisos siguientes mantienen la cadencia de 7 días y sí pagan plantilla.
 */

exports.shorthands = undefined;

const ANTERIORES = "tipo IN ('continuar_curso','evaluacion_pendiente','retomar','finalizar_curso')";
const NUEVOS = "tipo IN ('continuar_curso','evaluacion_pendiente','retomar','finalizar_curso','primer_aviso')";

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE reminder DROP CONSTRAINT IF EXISTS reminder_tipo_check`);
  pgm.sql(`ALTER TABLE reminder ADD CONSTRAINT reminder_tipo_check CHECK (${NUEVOS})`);
};

exports.down = (pgm) => {
  // Las filas del tipo nuevo impedirían recrear el CHECK anterior: se archivan como 'retomar',
  // que es el tipo más cercano, en vez de borrar historial de envíos.
  pgm.sql(`UPDATE reminder SET tipo='retomar' WHERE tipo='primer_aviso'`);
  pgm.sql(`ALTER TABLE reminder DROP CONSTRAINT IF EXISTS reminder_tipo_check`);
  pgm.sql(`ALTER TABLE reminder ADD CONSTRAINT reminder_tipo_check CHECK (${ANTERIORES})`);
};
