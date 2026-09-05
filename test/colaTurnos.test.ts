import { test } from 'node:test';
import assert from 'node:assert/strict';

// Cola de turnos (F11): payloads puros, roundtrip de decodificación y push FAIL-CLOSED sin SA.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.DEV_FAIL_OPEN = 'false';
process.env.PUBSUB_PUSH_SA = '';

const { construirMensajePubSub, decodificarTurno, pubsubHabilitado } = await import('../src/messaging/colaTurnos');
const { verifyPubSubPush } = await import('../src/routes/pubsub');
import type { InboundMessage } from '../src/messaging/types';
import type { Request, Response } from 'express';

const MSG: InboundMessage = {
  waMessageId: 'wamid.Q1',
  from: '+56912345678',
  timestamp: new Date('2026-09-01T15:00:00.000Z'),
  type: 'text',
  text: 'hola atlas',
};

test('construirMensajePubSub ↔ decodificarTurno: roundtrip con Date revivida y orderingKey por estudiante', () => {
  const m = construirMensajePubSub(MSG);
  assert.equal(m.orderingKey, '+56912345678');
  assert.equal(m.attributes.tipo, 'text');
  const de = decodificarTurno(m.data)!;
  assert.equal(de.waMessageId, 'wamid.Q1');
  assert.equal(de.text, 'hola atlas');
  assert.ok(de.timestamp instanceof Date);
  assert.equal(de.timestamp.toISOString(), '2026-09-01T15:00:00.000Z');
});

test('decodificarTurno: basura o campos faltantes → null (irá a ack + métrica, no revienta)', () => {
  assert.equal(decodificarTurno('no-es-base64-json'), null);
  assert.equal(decodificarTurno(Buffer.from('{"x":1}').toString('base64')), null);
  assert.equal(decodificarTurno(''), null);
});

test('sin PUBSUB_TOPIC: la cola está deshabilitada (modo in-process)', () => {
  assert.equal(pubsubHabilitado(), false);
});

test('push sin PUBSUB_PUSH_SA y sin DEV_FAIL_OPEN → 503 (fail-closed F12)', () => {
  const res: any = { statusCode: 200 };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = () => res;
  let paso = false;
  verifyPubSubPush({ header: () => undefined } as unknown as Request, res as Response, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(res.statusCode, 503);
});
