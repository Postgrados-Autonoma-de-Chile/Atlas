import { test } from 'node:test';
import assert from 'node:assert/strict';

// Gate de seguridad (Fase 12): redacción de RUT y fail-open SOLO con DEV_FAIL_OPEN explícito.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.DEV_FAIL_OPEN = 'true'; // este archivo prueba el camino dev explícito
process.env.DASHBOARD_TOKEN = '';
process.env.META_APP_SECRET = '';

const { redactPII } = await import('../src/obs/redact');
const { requireDashboardToken } = await import('../src/routes/guard');
const { verifyMetaSignature } = await import('../src/routes/whatsapp');
import type { Request, Response } from 'express';

test('redactPII: RUT en todas sus formas → [rut]; email y teléfono intactos como antes', () => {
  const out: any = redactPII({
    msg: 'mi rut es 12.345.678-5 y el de mi hermana 12345670-K, escribe a ana@x.cl o al +56912345678',
    campos: ['rut 12345678-5', 'código 654321 no es rut'],
    score: 80,
  });
  const s = JSON.stringify(out);
  assert.ok(!s.includes('12.345.678-5'));
  assert.ok(!s.includes('12345670-K'));
  assert.ok(!s.includes('12345678-5'));
  assert.ok(s.includes('[rut]'));
  assert.ok(s.includes('[email]'));
  assert.ok(s.includes('[tel]'));
  assert.ok(s.includes('654321'), 'un código de 6 dígitos NO se confunde con RUT');
  assert.equal(out.score, 80);
});

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as Response & { statusCode: number };
}
const req = { header: () => undefined, query: {} } as unknown as Request;

test('con DEV_FAIL_OPEN=true (solo dev): sin secretos configurados, deja pasar con aviso', () => {
  let guardNext = false;
  requireDashboardToken(req, fakeRes(), () => { guardNext = true; });
  assert.equal(guardNext, true);

  let sigNext = false;
  verifyMetaSignature(req, fakeRes(), () => { sigNext = true; });
  assert.equal(sigNext, true);
});
