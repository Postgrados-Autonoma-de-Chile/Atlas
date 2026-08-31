import { test } from 'node:test';
import assert from 'node:assert/strict';

// Gate de seguridad (Fase 12): SIN secretos y SIN DEV_FAIL_OPEN, todo es FAIL-CLOSED — también
// fuera de producción (el default heredado abría todo cuando NODE_ENV ≠ production).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.DEV_FAIL_OPEN = 'false';
process.env.DASHBOARD_TOKEN = '';
process.env.META_APP_SECRET = '';

const { requireDashboardToken } = await import('../src/routes/guard');
const { verifyMetaSignature } = await import('../src/routes/whatsapp');
import type { Request, Response } from 'express';

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as Response & { statusCode: number };
}
const req = { header: () => undefined, query: {} } as unknown as Request;

test('guard sin token configurado → 503 (fail-closed por defecto)', () => {
  const res = fakeRes();
  let paso = false;
  requireDashboardToken(req, res, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(res.statusCode, 503);
});

test('firma sin META_APP_SECRET → 503 (fail-closed por defecto)', () => {
  const res = fakeRes();
  let paso = false;
  verifyMetaSignature(req, res, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(res.statusCode, 503);
});
