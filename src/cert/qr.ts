import qrcode from 'qrcode-generator';
import type { PDFPage, RGB } from 'pdf-lib';

// Dibujo del QR de verificación directamente en el PDF, sin generar una imagen.
//
// qrcode-generator no tiene dependencias y solo calcula la matriz de módulos; el trazado lo hacemos
// con rectángulos de pdf-lib. Queda vectorial: nítido impreso y al hacer zoom, que es justo lo que
// un QR necesita para que la cámara lo lea desde una hoja.

export type OpcionesQr = {
  /** Esquina inferior izquierda del QR, en puntos de la página. */
  x: number;
  y: number;
  /** Lado del cuadrado, en puntos (sin contar el margen blanco). */
  lado: number;
  color: RGB;
};

/**
 * Corrección de errores media: tolera ~15% de daño. Suficiente para papel y pantalla, y mantiene la
 * matriz chica — un QR denso se lee mal en una impresión doméstica o en la cámara de un celular
 * viejo, que es exactamente el equipo de la persona a la que va dirigido este certificado.
 */
const CORRECCION = 'M' as const;

export function dibujarQr(page: PDFPage, texto: string, o: OpcionesQr): void {
  const qr = qrcode(0, CORRECCION); // 0 = elige el tamaño mínimo que quepa
  qr.addData(texto);
  qr.make();

  const n = qr.getModuleCount();
  const modulo = o.lado / n;

  // Se fusionan los módulos oscuros CONTIGUOS de cada fila en un solo rectángulo. Sin esto un QR
  // típico son ~700 rectángulos; así bajan a ~200. Además evita las hairlines: dos rectángulos
  // pegados pueden dejar una línea clara de un subpíxel al rasterizar, y en un QR eso es un módulo
  // roto.
  for (let fila = 0; fila < n; fila++) {
    let inicio = -1;
    for (let col = 0; col <= n; col++) {
      const oscuro = col < n && qr.isDark(fila, col);
      if (oscuro && inicio === -1) inicio = col;
      if (!oscuro && inicio !== -1) {
        page.drawRectangle({
          x: o.x + inicio * modulo,
          // La fila 0 del QR es la de ARRIBA; la página mide y hacia arriba desde abajo.
          y: o.y + o.lado - (fila + 1) * modulo,
          width: (col - inicio) * modulo,
          height: modulo,
          color: o.color,
        });
        inicio = -1;
      }
    }
  }
}
