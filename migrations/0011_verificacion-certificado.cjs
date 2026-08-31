/**
 * Verificación pública del certificado (QR y compartir en LinkedIn).
 *
 * El folio es SECUENCIAL (ATLAS-2026-0001, 0002, ...). Si la página pública se resolviera solo con
 * él, cualquiera podría recorrer los folios y obtener el nombre y el curso de cada estudiante de la
 * cohorte — 10.000 personas. Por eso cada certificado lleva además un código aleatorio: la URL
 * exige folio Y código, y sin ambos la página responde "no encontrado".
 *
 * El código NO es un secreto que proteja al titular: quien tenga el certificado puede compartirlo.
 * Sirve para impedir la ENUMERACIÓN masiva, que es el riesgo real.
 */
exports.up = (pgm) => {
  pgm.addColumns('certificate', {
    // 16 hex = 64 bits: irrecorrible por fuerza bruta, y corto para que el QR quede de baja densidad
    // (un QR denso se lee mal impreso o en pantalla de celular).
    codigo_verificacion: { type: 'text' },
  });
  // Se rellena al emitir; las filas ya emitidas (el piloto tiene una) reciben el suyo aquí.
  pgm.sql(`UPDATE certificate SET codigo_verificacion = encode(gen_random_bytes(8), 'hex') WHERE folio IS NOT NULL AND codigo_verificacion IS NULL`);
  pgm.createIndex('certificate', ['folio', 'codigo_verificacion']);
};

exports.down = (pgm) => {
  pgm.dropIndex('certificate', ['folio', 'codigo_verificacion']);
  pgm.dropColumns('certificate', ['codigo_verificacion']);
};
