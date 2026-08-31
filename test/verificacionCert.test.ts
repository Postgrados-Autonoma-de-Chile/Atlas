import { test } from 'node:test';
import assert from 'node:assert/strict';

// QR de verificación y compartir en LinkedIn.
//
// Ambos dependen de una página pública, y esa página tiene un riesgo concreto: el folio es
// SECUENCIAL (ATLAS-2026-0001, 0002, ...). Resolverla solo con el folio permitiría recorrer la
// cohorte completa y extraer el nombre y el curso de cada estudiante — 10.000 personas en el
// piloto. De ahí el código aleatorio, y de ahí que estas pruebas insistan en él.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { dibujarQr } = await import('../src/cert/qr');
const { enlaceLinkedIn } = await import('../src/flows/certificacion');
const { generarCertificadoPdf } = await import('../src/cert/pdf');
const { PDFDocument, rgb } = await import('pdf-lib');

const URL_EJEMPLO = 'https://atlas.example.app/verificar/ATLAS-2026-0001?c=a1b2c3d4e5f60718';

function paginaFalsa() {
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  return { page: { drawRectangle: (o: any) => rects.push(o) } as any, rects };
}

test('el QR dibuja módulos y ninguno se sale del cuadrado declarado', () => {
  const { page, rects } = paginaFalsa();
  const x = 64, y = 64, lado = 84;
  dibujarQr(page, URL_EJEMPLO, { x, y, lado, color: rgb(0, 0, 0) });
  assert.ok(rects.length > 20, `un QR real trae muchos módulos, se dibujaron ${rects.length}`);
  for (const r of rects) {
    assert.ok(r.x >= x - 0.01 && r.x + r.width <= x + lado + 0.01, 'módulo fuera del ancho');
    assert.ok(r.y >= y - 0.01 && r.y + r.height <= y + lado + 0.01, 'módulo fuera del alto');
  }
});

test('los módulos contiguos se fusionan: menos rectángulos que módulos oscuros', () => {
  const { page, rects } = paginaFalsa();
  dibujarQr(page, URL_EJEMPLO, { x: 0, y: 0, lado: 100, color: rgb(0, 0, 0) });
  // Sin fusión un QR de esta URL pasa de 500 rectángulos; con fusión baja muy por debajo.
  assert.ok(rects.length < 400, `esperaba menos de 400 rectángulos fusionados, hubo ${rects.length}`);
  assert.ok(rects.some((r) => r.width > r.height * 1.5), 'debería haber al menos una fila fusionada');
});

test('un texto más largo produce un QR más denso, no uno desbordado', () => {
  const corto = paginaFalsa();
  const largo = paginaFalsa();
  dibujarQr(corto.page, 'https://a.cl/v/1?c=1', { x: 0, y: 0, lado: 84, color: rgb(0, 0, 0) });
  dibujarQr(largo.page, URL_EJEMPLO + '&extra=' + 'x'.repeat(120), { x: 0, y: 0, lado: 84, color: rgb(0, 0, 0) });
  const alto = (r: any[]) => Math.min(...r.map((m) => m.height));
  assert.ok(alto(largo.rects) < alto(corto.rects), 'más datos = módulos más chicos dentro del mismo lado');
  for (const r of largo.rects) assert.ok(r.x + r.width <= 84.01, 'sigue dentro del cuadrado');
});

test('el certificado SIN url de verificación no dibuja QR (nada que verificar)', async () => {
  const base = { nombreCompleto: 'Rodrigo Palma', curso: 'Alfabetización ciudadana en IA', minutos: 58, folio: 'ATLAS-2026-0001', fecha: new Date('2026-08-31T00:00:00Z') };
  const sinQr = await generarCertificadoPdf(base);
  const conQr = await generarCertificadoPdf({ ...base, urlVerificacion: URL_EJEMPLO });
  assert.ok(conQr.length > sinQr.length, 'el PDF con QR debe pesar más: trae los módulos dibujados');
  const doc = await PDFDocument.load(sinQr);
  assert.equal(doc.getPageCount(), 1);
});

test('enlaceLinkedIn lleva los datos que LinkedIn exige y la URL de verificación', () => {
  const url = enlaceLinkedIn('Alfabetización ciudadana en IA', 'ATLAS-2026-0001', URL_EJEMPLO, new Date('2026-08-31T12:00:00'));
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.linkedin.com/profile/add');
  assert.equal(u.searchParams.get('startTask'), 'CERTIFICATION_NAME');
  assert.equal(u.searchParams.get('name'), 'Alfabetización ciudadana en IA');
  assert.equal(u.searchParams.get('organizationName'), 'Universidad Autónoma de Chile');
  assert.equal(u.searchParams.get('certId'), 'ATLAS-2026-0001');
  assert.equal(u.searchParams.get('certUrl'), URL_EJEMPLO, 'sin certUrl LinkedIn no marca la credencial como verificable');
  assert.equal(u.searchParams.get('issueYear'), '2026');
  assert.equal(u.searchParams.get('issueMonth'), '8', 'getMonth() es base 0; LinkedIn espera 1-12');
});

test('la url de verificación se arma con folio Y código', () => {
  const folio = 'ATLAS-2026-0001';
  const codigo = 'a1b2c3d4e5f60718';
  const url = `https://atlas.example.app/verificar/${encodeURIComponent(folio)}?c=${encodeURIComponent(codigo)}`;
  const u = new URL(url);
  assert.match(u.pathname, /\/verificar\/ATLAS-2026-0001$/);
  assert.equal(u.searchParams.get('c'), codigo);
  assert.equal(codigo.length, 16, '8 bytes en hex = 64 bits: no se recorre por fuerza bruta');
});
