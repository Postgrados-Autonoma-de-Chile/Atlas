import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// tokenGuard (requireDashboardToken): auth por HEADER en tiempo constante. Cubre el hueco señalado
// por la auditoría (el guard de tokens no tenía tests) y verifica que la query string YA NO autentica.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.DASHBOARD_TOKEN = 'tok-panel-test';

const { requireDashboardToken } = await import('../src/routes/guard');

function fakeReq(headers: Record<string, string>, query: Record<string, string> = {}): Request {
  return { header: (n: string) => headers[n.toLowerCase()], query } as unknown as Request;
}
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as Response & { statusCode: number; body: any };
}

test('requireDashboardToken: header correcto deja pasar (next)', () => {
  const res = fakeRes();
  let called = false;
  requireDashboardToken(fakeReq({ 'x-dashboard-token': 'tok-panel-test' }), res, () => { called = true; });
  assert.equal(called, true);
});

test('requireDashboardToken: header incorrecto → 401', () => {
  const res = fakeRes();
  let called = false;
  requireDashboardToken(fakeReq({ 'x-dashboard-token': 'malo' }), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('requireDashboardToken: el token por query string YA NO autentica', () => {
  const res = fakeRes();
  let called = false;
  requireDashboardToken(fakeReq({}, { k: 'tok-panel-test' }), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});
