import { test } from 'node:test';
import assert from 'node:assert/strict';

// Smoke del PDF real del certificado (pdf-lib, sin red).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { generarCertificadoPdf } = await import('../src/cert/pdf');

test('generarCertificadoPdf: produce un PDF real con los datos', async () => {
  const buf = await generarCertificadoPdf({
    nombreCompleto: 'Rodrigo Palma',
    curso: 'IA en la vida cotidiana',
    minutos: 58,
    folio: 'ATLAS-2026-0001',
    fecha: new Date('2026-09-01T15:00:00Z'),
  });
  assert.ok(buf.length > 1000, 'PDF con contenido');
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
});
