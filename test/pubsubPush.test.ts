import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Endpoint /pubsub/turnos (F11): envelope válido → despacha el turno decodificado y ackea (204);
// envelope malformado → ack sin despachar. despacharMensaje SIMULADO (el pipeline tiene su suite).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.DEV_FAIL_OPEN = 'true'; // salta la verificación OIDC para probar el handler

const despachados: any[] = [];
mock.module('../src/routes/whatsapp.ts', {
  namedExports: {
    despacharMensaje: async (msg: any) => { despachados.push(msg); },
    metaVerify: () => {},
    verifyMetaSignature: () => {},
    metaWebhook: () => {},
    procesarMensajeEntrante: async () => {},
  },
});

const { pubsubTurnos } = await import('../src/routes/pubsub');
const { construirMensajePubSub } = await import('../src/messaging/colaTurnos');
import type { Request, Response } from 'express';

function fakeRes() {
  const res: any = { statusCode: 0 };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.end = () => res;
  res.json = () => res;
  return res as Response & { statusCode: number };
}

test('envelope válido: decodifica, despacha y ackea con 204', async () => {
  const m = construirMensajePubSub({
    waMessageId: 'wamid.P1', from: '+56911112222', timestamp: new Date(), type: 'text', text: 'sigo con el curso',
  });
  const req = { body: { message: { data: m.data, messageId: '123' }, subscription: 's' } } as unknown as Request;
  const res = fakeRes();
  await pubsubTurnos(req, res);
  assert.equal(res.statusCode, 204);
  assert.equal(despachados.length, 1);
  assert.equal(despachados[0].waMessageId, 'wamid.P1');
  assert.equal(despachados[0].text, 'sigo con el curso');
});

test('envelope malformado: ackea (204) sin despachar', async () => {
  const req = { body: { message: { data: 'zzz-no-json', messageId: '124' } } } as unknown as Request;
  const res = fakeRes();
  const antes = despachados.length;
  await pubsubTurnos(req, res);
  assert.equal(res.statusCode, 204);
  assert.equal(despachados.length, antes);
});
