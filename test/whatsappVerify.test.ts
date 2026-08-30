import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Request, Response } from 'express';

// Webhook de WhatsApp Cloud API — piezas comunes de Meta: handshake GET (hub.challenge) y
// verificación de firma X-Hub-Signature-256 sobre el body CRUDO. (El receptor de mensajes llega en F10.)
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.META_VERIFY_TOKEN = 'verify-test-token';
process.env.META_APP_SECRET = 'app-secret-test';

const { metaVerify, verifyMetaSignature } = await import('../src/routes/whatsapp');

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.sendStatus = (c: number) => ((res.statusCode = c), res);
  res.send = (b: unknown) => ((res.body = b), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as Response & { statusCode: number; body: any };
}

test('metaVerify: handshake correcto devuelve el challenge', () => {
  const req = { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-test-token', 'hub.challenge': 'reto-123' } } as unknown as Request;
  const res = fakeRes();
  metaVerify(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'reto-123');
});

test('metaVerify: token incorrecto → 403', () => {
  const req = { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': 'x' } } as unknown as Request;
  const res = fakeRes();
  metaVerify(req, res);
  assert.equal(res.statusCode, 403);
});

function reqConFirma(payload: string, secreto: string | null) {
  const raw = Buffer.from(payload);
  const sig = secreto ? 'sha256=' + crypto.createHmac('sha256', secreto).update(raw).digest('hex') : '';
  return {
    rawBody: raw,
    header: (n: string) => (n.toLowerCase() === 'x-hub-signature-256' ? sig : undefined),
  } as unknown as Request;
}

test('verifyMetaSignature: firma válida deja pasar (next)', () => {
  const req = reqConFirma('{"object":"whatsapp_business_account"}', 'app-secret-test');
  const res = fakeRes();
  let called = false;
  verifyMetaSignature(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('verifyMetaSignature: firma inválida → 401', () => {
  const req = reqConFirma('{"object":"whatsapp_business_account"}', 'otro-secreto');
  const res = fakeRes();
  let called = false;
  verifyMetaSignature(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('verifyMetaSignature: sin rawBody → 500 (falta el verify de express.json)', () => {
  const req = { header: () => 'sha256=xx' } as unknown as Request;
  const res = fakeRes();
  verifyMetaSignature(req, res, () => {});
  assert.equal(res.statusCode, 500);
});
