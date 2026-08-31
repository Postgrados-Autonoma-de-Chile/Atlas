import { test } from 'node:test';
import assert from 'node:assert/strict';

// Capa de mensajería (Fase 2): constructores de payload PUROS + normalización del webhook de
// Cloud API + comportamiento skip cuando el proveedor no está configurado (sin red).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_PROVIDER = ''; // desactivado → los envíos deben omitirse sin tocar la red

const { payloadTexto, payloadPlantilla, payloadBotones, payloadLista, payloadDocumento, normalizarEntrante, normalizarE164, MetaCloudProvider } =
  await import('../src/messaging/metaCloud');

test('normalizarE164: wa_id de Meta (sin +) → E.164 con +', () => {
  assert.equal(normalizarE164('56912345678'), '+56912345678');
  assert.equal(normalizarE164('+56 9 1234 5678'), '+56912345678');
  assert.equal(normalizarE164(''), '');
});

test('payloadPlantilla: template con parámetro de body (comportamiento heredado)', () => {
  const p = payloadPlantilla('+56912345678', 'recordatorio_curso', 'es', ['Rodrigo']);
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.to, '56912345678'); // sin el '+'
  assert.equal(p.type, 'template');
  assert.equal(p.template.name, 'recordatorio_curso');
  assert.equal(p.template.language.code, 'es');
  assert.deepEqual((p.template as any).components, [{ type: 'body', parameters: [{ type: 'text', text: 'Rodrigo' }] }]);
});

test('payloadPlantilla: sin parámetros no incluye components', () => {
  const p = payloadPlantilla('+56912345678', 'bienvenida', 'es', []);
  assert.equal('components' in p.template, false);
});

test('payloadTexto: sobrevive comillas y backslash (el bug del modo custom murió con él)', () => {
  const p = payloadTexto('+56912345678', 'Hola "Rodrigo" \\ $100');
  assert.equal(p.text.body, 'Hola "Rodrigo" \\ $100');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(p)));
});

test('payloadBotones: máximo 3 botones tipo reply', () => {
  const p = payloadBotones('+569', '¿Verdadero o falso?', [
    { id: 'v', titulo: 'Verdadero' }, { id: 'f', titulo: 'Falso' },
    { id: 'x', titulo: 'Extra' }, { id: 'y', titulo: 'Sobra' },
  ]);
  assert.equal(p.interactive.type, 'button');
  assert.equal(p.interactive.action.buttons.length, 3);
  assert.deepEqual(p.interactive.action.buttons[0], { type: 'reply', reply: { id: 'v', title: 'Verdadero' } });
});

test('payloadLista: filas con descripción opcional', () => {
  const p = payloadLista('+569', 'Elige una alternativa', 'Responder', [
    { id: 'a', titulo: 'A', descripcion: 'Primera' }, { id: 'b', titulo: 'B' },
  ]);
  assert.equal(p.interactive.type, 'list');
  const rows = p.interactive.action.sections[0].rows;
  assert.deepEqual(rows[0], { id: 'a', title: 'A', description: 'Primera' });
  assert.deepEqual(rows[1], { id: 'b', title: 'B' });
});

test('payloadDocumento: distingue URL pública de media id', () => {
  const porUrl = payloadDocumento('+569', 'https://x.cl/cert.pdf', 'certificado.pdf', 'Tu certificado');
  assert.equal((porUrl.document as any).link, 'https://x.cl/cert.pdf');
  const porId = payloadDocumento('+569', '123456789', 'certificado.pdf');
  assert.equal((porId.document as any).id, '123456789');
});

test('normalizarEntrante: texto + interactivo + status en un mismo webhook', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          contacts: [{ wa_id: '56912345678' }],
          messages: [
            { id: 'wamid.T1', from: '56912345678', timestamp: '1756500000', type: 'text', text: { body: 'hola' } },
            { id: 'wamid.T2', from: '56912345678', timestamp: '1756500060', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'v', title: 'Verdadero' } } },
            { id: 'wamid.T3', from: '56912345678', timestamp: '1756500120', type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg' } },
            { id: 'wamid.T4', from: '56912345678', timestamp: '1756500150', type: 'button', button: { payload: 'continuar', text: 'Continuar curso' } },
            { id: 'wamid.T5', from: '56912345678', timestamp: '1756500180', type: 'document', document: { id: 'DOC1', filename: 'apuntes.pdf', caption: 'mira esto' } },
          ],
          statuses: [
            { id: 'wamid.OUT1', status: 'delivered', timestamp: '1756500030', recipient_id: '56912345678' },
            { id: 'wamid.OUT2', status: 'failed', timestamp: '1756500031', recipient_id: '56912345678', errors: [{ code: 131047 }] },
          ],
        },
      }],
    }],
  };
  const ev = normalizarEntrante(body);
  assert.equal(ev.messages.length, 5);
  assert.deepEqual(
    ev.messages.map((m) => m.type),
    ['text', 'interactive', 'audio', 'interactive', 'document'],
  );
  assert.equal(ev.messages[0].text, 'hola');
  assert.equal(ev.messages[0].from, '+56912345678');
  assert.equal(ev.messages[1].interactiveReplyId, 'v');
  assert.equal(ev.messages[1].interactiveReplyTitle, 'Verdadero');
  assert.equal(ev.messages[2].mediaId, 'MEDIA1');
  // Quick-reply de PLANTILLA (type 'button' en Cloud API) → normalizado como interactive (F9.1).
  assert.equal(ev.messages[3].interactiveReplyId, 'continuar');
  assert.equal(ev.messages[3].interactiveReplyTitle, 'Continuar curso');
  // Documento: filename separado del caption (F9.1).
  assert.equal(ev.messages[4].filename, 'apuntes.pdf');
  assert.equal(ev.messages[4].text, 'mira esto');
  assert.equal(ev.statuses.length, 2);
  assert.equal(ev.statuses[0].status, 'delivered');
  assert.equal(ev.statuses[1].errorCode, '131047');
});

test('normalizarEntrante: body ajeno o vacío → evento vacío (no revienta)', () => {
  assert.deepEqual(normalizarEntrante({}), { messages: [], statuses: [] });
  assert.deepEqual(normalizarEntrante({ entry: [{ changes: [{ value: { messaging_product: 'otro' } }] }] }), { messages: [], statuses: [] });
});

test('provider sin configurar: enviarTexto se omite sin tocar la red', async () => {
  const p = new MetaCloudProvider();
  assert.equal(p.configurado(), false);
  const r = await p.enviarTexto('+56912345678', 'hola');
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
});
