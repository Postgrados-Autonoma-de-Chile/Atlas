import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { LOGO_ALTO, LOGO_ANCHO, LOGO_COLOR, LOGO_RELLENOS, LOGO_TRAZOS } from './logoUa';

// Generación del certificado del piloto (Fase 8): PDF A4 apaisado, simple y verificable por folio.
// Cuando la Universidad conecte su sistema institucional (folios/firmas propias), esta función se
// reemplaza sin tocar el flujo conversacional.

export type DatosCertificado = {
  nombreCompleto: string;
  curso: string;
  minutos: number;
  folio: string;
  fecha: Date;
};

export async function generarCertificadoPdf(d: DatosCertificado): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]); // A4 apaisado
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const azul = rgb(0.08, 0.2, 0.4);
  const gris = rgb(0.35, 0.4, 0.45);

  const centrar = (texto: string, y: number, font = normal, size = 14, color = gris) => {
    const w = font.widthOfTextAtSize(texto, size);
    page.drawText(texto, { x: (842 - w) / 2, y, size, font, color });
  };

  // Marco simple
  page.drawRectangle({ x: 28, y: 28, width: 842 - 56, height: 595 - 56, borderColor: azul, borderWidth: 2 });
  page.drawRectangle({ x: 36, y: 36, width: 842 - 72, height: 595 - 72, borderColor: azul, borderWidth: 0.75 });

  // Logo institucional de Postgrados, centrado arriba. Va como trazados vectoriales (ver logoUa.ts):
  // el bloque ya dice "Universidad Autónoma de Chile", así que REEMPLAZA a la línea de texto que
  // estaba aquí antes en vez de repetirla. drawSvgPath toma (x, y) como esquina SUPERIOR izquierda y
  // dibuja hacia abajo, al revés que el resto de la página.
  const escala = 0.72;
  const logoX = (842 - LOGO_ANCHO * escala) / 2;
  const logoY = 543;
  for (const d of LOGO_RELLENOS) {
    page.drawSvgPath(d, { x: logoX, y: logoY, scale: escala, color: LOGO_COLOR });
  }
  for (const t of LOGO_TRAZOS) {
    page.drawSvgPath(t.d, { x: logoX, y: logoY, scale: escala, borderColor: LOGO_COLOR, borderWidth: t.grosor * escala });
  }

  centrar('Programa ATLAS — Formación por microlearning', logoY - LOGO_ALTO * escala - 18, normal, 12);
  centrar('CERTIFICADO DE FINALIZACIÓN', 420, bold, 26, azul);
  centrar('Se certifica que', 370, normal, 14);
  centrar(d.nombreCompleto, 330, bold, 30, rgb(0.1, 0.1, 0.12));
  centrar('completó satisfactoriamente el curso', 292, normal, 14);
  centrar(`"${d.curso}"`, 260, bold, 20, azul);
  centrar(`con ${d.minutos} minutos de formación certificada`, 228, normal, 13);

  const fecha = d.fecha.toLocaleDateString('es-CL', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Santiago' });
  centrar(`Emitido el ${fecha}`, 150, normal, 12);
  centrar(`Folio de verificación: ${d.folio}`, 128, bold, 12, gris);
  centrar('Documento generado electrónicamente por ATLAS, tutor virtual de la Universidad Autónoma de Chile.', 78, normal, 9);

  return Buffer.from(await doc.save());
}
