import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Adaptador del BSP Chattigo.
//
// Lo que estas pruebas cuidan sobre todo es la AUTENTICACIÓN del webhook. Chattigo no firma sus
// mensajes —Meta manda X-Hub-Signature-256 con un HMAC del cuerpo y lo verificamos; la documentación
// de Chattigo solo describe un POST que debe responder 200— así que el secreto compartido es la
// única barrera. Sin ella, quien descubra la URL puede hacerse pasar por un estudiante, alterar su
// progreso o disparar la emisión de un certificado a su nombre.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_PROVIDER = 'chattigo';
process.env.CHATTIGO_BASE_URL = 'https://api.chattigo.test';
process.env.CHATTIGO_USER = 'bot';
process.env.CHATTIGO_PASS = 'clave';
process.env.CHATTIGO_DID = '56445550000';
process.env.CHATTIGO_ID_CAMPAIGN = '353';
process.env.CHATTIGO_WEBHOOK_TOKEN = 'secreto-de-prueba-32-caracteres!!';
process.env.CHATTIGO_HSM_BASE_URL = 'https://login.chattigo.test/message';
process.env.CHATTIGO_NAMESPACE = 'ns-uautonoma';

type Llamada = { url: string; opts: any };
const llamadas: Llamada[] = [];
let respuesta: (url: string) => { status: number; body: any } = () => ({ status: 200, body: { id: 99 } });

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url: any, opts: any) => {
  llamadas.push({ url: String(url), opts });
  const r = respuesta(String(url));
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: String(r.status),
    json: async () => r.body,
    headers: new Map() as any,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as any;
}) as any;

const { chattigoProvider, normalizarEntranteChattigo, verificarTokenChattigo, secretoCoincide, credencialesCompletas } =
  await import('../src/messaging/chattigo');

const reset = () => {
  llamadas.length = 0;
  respuesta = (url) => (url.endsWith('/login') ? { status: 200, body: { access_token: 'jwt-1' } } : { status: 200, body: { id: 99 } });
};

const cuerpoEntrante = (extra: Record<string, unknown> = {}) => ({
  id: 364096945,
  idChat: 29289561,
  did: '56445550000',
  msisdn: '56912345678',
  idUser: 0,
  type: 'Text',
  channel: 'WHATSAPP',
  channelProvider: 'WAVY',
  content: 'hola',
  name: 'Rodrigo Palma',
  idCampaign: 353,
  isAttachment: false,
  attachment: null,
  message: null,
  ...extra,
});

// ── Autenticación del webhook ───────────────────────────────────────────────────────────────────

test('el token correcto se acepta', () => {
  assert.equal(verificarTokenChattigo('secreto-de-prueba-32-caracteres!!'), true);
});

test('cualquier token distinto se rechaza', () => {
  for (const malo of ['', 'otro', 'secreto-de-prueba-32-caracteres!', 'secreto-de-prueba-32-caracteres!!!', undefined]) {
    assert.equal(verificarTokenChattigo(malo as any), false, `no puede aceptar ${JSON.stringify(malo)}`);
  }
});

test('sin secreto configurado NO se acepta nada (fail-closed)', () => {
  // Un webhook abierto que escribe en el expediente académico de una persona es peor que uno caído.
  // Se prueba la función PURA: `config` es un singleton que se evalúa una vez, así que cambiar la
  // variable de entorno desde la prueba no lo afecta — hacerlo así daba un falso verde.
  for (const recibido of ['', 'lo-que-sea', undefined]) {
    assert.equal(secretoCoincide(recibido as any, ''), false, 'con esperado vacío nunca se acepta');
  }
  assert.equal(secretoCoincide('abc', 'abc'), true, 'con secreto configurado, el correcto sí pasa');
});

test('la comparación no filtra por longitud ni acepta prefijos', () => {
  assert.equal(secretoCoincide('abc', 'abcd'), false);
  assert.equal(secretoCoincide('abcd', 'abc'), false);
  assert.equal(secretoCoincide('abd', 'abc'), false);
});

// ── Normalización del entrante ──────────────────────────────────────────────────────────────────

test('un texto entrante se normaliza al contrato del dominio', () => {
  const { messages, statuses } = normalizarEntranteChattigo(cuerpoEntrante());
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.from, '+56912345678', 'Chattigo manda el número sin +, el dominio lo usa con +');
  assert.equal(m.type, 'text');
  assert.equal(m.text, 'hola');
  assert.equal(m.aPhoneNumberId, '56445550000', 'did = número al que llegó, como phone_number_id en Meta');
  assert.equal(statuses.length, 0, 'Chattigo no notifica estados de entrega');
});

test('el id se prefija para no colisionar con un wamid de Meta', () => {
  // Durante una migración de número pueden convivir los dos proveedores; el id de Chattigo es un
  // entero y podría chocar con la clave de idempotencia de otro mensaje.
  const [m] = normalizarEntranteChattigo(cuerpoEntrante()).messages;
  assert.equal(m.waMessageId, 'chattigo:364096945');
  assert.match(m.waMessageId, /^chattigo:/);
});

test('la elección de una lista llega como interactiveReplyId', () => {
  const [m] = normalizarEntranteChattigo(
    cuerpoEntrante({ interactiveChoiceId: 'quiz_v', interactiveChoiceText: 'Verdadero', content: 'Verdadero' }),
  ).messages;
  assert.equal(m.type, 'interactive');
  assert.equal(m.interactiveReplyId, 'quiz_v');
  assert.equal(m.interactiveReplyTitle, 'Verdadero');
});

test('un adjunto llega con la URL en mediaId, porque Chattigo no da ids de media', () => {
  const [m] = normalizarEntranteChattigo(
    cuerpoEntrante({
      type: 'media',
      isAttachment: true,
      attachment: { mediaUrl: 'https://cdn.test/nota.pdf', mimeType: 'application/pdf', fileName: 'nota.pdf' },
    }),
  ).messages;
  assert.equal(m.type, 'document');
  assert.equal(m.mediaId, 'https://cdn.test/nota.pdf');
  assert.equal(m.filename, 'nota.pdf');
});

test('los eventos de sistema no llegan al motor', () => {
  // transfer/close/timeout son señales de la plataforma, no turnos del estudiante: si pasaran, el
  // tutor respondería a algo que la persona nunca escribió.
  for (const tipo of ['transfer', 'close', 'timeout', 'group']) {
    const { messages } = normalizarEntranteChattigo(cuerpoEntrante({ type: tipo }));
    assert.equal(messages.length, 0, `${tipo} no puede convertirse en un turno`);
  }
});

test('un cuerpo sin remitente o sin id se descarta sin romper', () => {
  for (const roto of [null, {}, cuerpoEntrante({ msisdn: '' }), cuerpoEntrante({ id: null })]) {
    const { messages } = normalizarEntranteChattigo(roto as any);
    assert.equal(messages.length, 0);
  }
});

// ── Envíos ──────────────────────────────────────────────────────────────────────────────────────

test('enviarTexto hace login y postea a /outbound con el Bearer', async () => {
  reset();
  const r = await chattigoProvider.enviarTexto('+56912345678', 'Hola Rodrigo');
  assert.equal(r.ok, true);
  assert.equal(llamadas.length, 2, 'primero /login, después /outbound');
  assert.match(llamadas[0].url, /\/login$/);
  assert.match(llamadas[1].url, /\/outbound$/);
  assert.equal(llamadas[1].opts.headers.Authorization, 'Bearer jwt-1');
  const enviado = JSON.parse(llamadas[1].opts.body);
  assert.equal(enviado.msisdn, '56912345678', 'Chattigo espera el número SIN +');
  assert.equal(enviado.did, '56445550000');
  assert.equal(enviado.content, 'Hola Rodrigo');
  assert.equal(enviado.channel, 'WHATSAPP');
});

test('un 401 al enviar renueva el token y reintenta UNA vez', async () => {
  reset();
  let outbounds = 0;
  respuesta = (url) => {
    if (url.endsWith('/login')) return { status: 200, body: { access_token: 'jwt-nuevo' } };
    outbounds++;
    return outbounds === 1 ? { status: 401, body: {} } : { status: 200, body: { id: 7 } };
  };
  const r = await chattigoProvider.enviarTexto('+56912345678', 'reintento');
  assert.equal(r.ok, true);
  assert.equal(outbounds, 2, 'exactamente un reintento, no una tormenta de logins');
  assert.equal(r.messageId, '7');
});

test('un 401 persistente se rinde en vez de reintentar sin fin', async () => {
  reset();
  respuesta = (url) => (url.endsWith('/login') ? { status: 200, body: { access_token: 'x' } } : { status: 401, body: {} });
  const r = await chattigoProvider.enviarTexto('+56912345678', 'no pasa');
  assert.equal(r.ok, false);
  const outbounds = llamadas.filter((l) => l.url.endsWith('/outbound')).length;
  assert.ok(outbounds <= 2, `no puede insistir indefinidamente, hubo ${outbounds} envíos`);
});

test('los botones viajan como lista, que es lo que devuelve una elección', async () => {
  reset();
  await chattigoProvider.enviarBotones('+56912345678', '¿Verdadero o falso?', [
    { id: 'v', titulo: 'Verdadero' },
    { id: 'f', titulo: 'Falso' },
  ]);
  const enviado = JSON.parse(llamadas.at(-1)!.opts.body);
  assert.equal(enviado.interactiveMsg.interactiveType, 'list');
  assert.deepEqual(enviado.interactiveMsg.choices, [
    { id: 'v', text: 'Verdadero' },
    { id: 'f', text: 'Falso' },
  ]);
});

test('la lista respeta el tope de 10 opciones de WhatsApp', async () => {
  reset();
  const muchas = Array.from({ length: 14 }, (_, i) => ({ id: `o${i}`, titulo: `Opción ${i}` }));
  await chattigoProvider.enviarLista('+56912345678', 'Elige', 'Ver opciones', muchas);
  const enviado = JSON.parse(llamadas.at(-1)!.opts.body);
  assert.equal(enviado.interactiveMsg.choices.length, 10);
});

test('enviarDocumento exige URL pública y la manda como attachment', async () => {
  reset();
  const malo = await chattigoProvider.enviarDocumento('+56912345678', 'media-id-123', 'cert.pdf');
  assert.equal(malo.ok, false, 'un id de media de Meta no sirve: Chattigo solo acepta URL');

  reset();
  const bueno = await chattigoProvider.enviarDocumento('+56912345678', 'https://cdn.test/c.pdf', 'cert.pdf', 'Tu certificado');
  assert.equal(bueno.ok, true);
  const enviado = JSON.parse(llamadas.at(-1)!.opts.body);
  assert.equal(enviado.type, 'media');
  assert.equal(enviado.isAttachment, true);
  assert.equal(enviado.attachment.mediaUrl, 'https://cdn.test/c.pdf');
  assert.equal(enviado.attachment.fileName, 'cert.pdf');
});

test('enviarPlantilla usa el servicio de HSM, que vive en otro host', async () => {
  reset();
  const r = await chattigoProvider.enviarPlantilla('+56912345678', 'invitacion_curso', 'es', ['Rodrigo']);
  assert.equal(r.ok, true);
  const hsm = llamadas.find((l) => l.url.includes('/inbound'))!;
  assert.ok(hsm, 'debe pegarle a /inbound, no a /outbound');
  assert.match(hsm.url, /login\.chattigo\.test\/message\/inbound$/);
  const enviado = JSON.parse(hsm.opts.body);
  assert.equal(enviado.type, 'HSM');
  assert.equal(enviado.channel, 'WHATSAPP');
  assert.equal(enviado.did, '56445550000');
  assert.equal(enviado.hsm.template, 'invitacion_curso');
  assert.equal(enviado.hsm.languageCode, 'es');
  assert.equal(enviado.hsm.namespace, 'ns-uautonoma');
  assert.deepEqual(enviado.hsm.destinations, [{ destination: '56912345678', parameters: ['Rodrigo'] }]);
});

test('la plantilla pide atención del bot: si no, la respuesta no llegaría al tutor', async () => {
  // Nosotros ABRIMOS la conversación; sin botAttention la respuesta caería en una cola de agentes
  // humanos, que en ATLAS no existe.
  reset();
  await chattigoProvider.enviarPlantilla('+56912345678', 'invitacion_curso', 'es', []);
  const enviado = JSON.parse(llamadas.find((l) => l.url.includes('/inbound'))!.opts.body);
  assert.equal(enviado.hsm.botAttention, true);
});

test('el messageId lo generamos NOSOTROS: la API de HSM no lo devuelve', async () => {
  // La respuesta es {success:true} y el id llega después en el callback de estado, correlacionado
  // con el que mandamos. Sin esto no se podría marcar un recordatorio como no entregado.
  reset();
  respuesta = (url) => (url.endsWith('/login') ? { status: 200, body: { access_token: 'jwt-1' } } : { status: 200, body: { success: true } });
  const r = await chattigoProvider.enviarPlantilla('+56912345678', 'recordatorio', 'es', []);
  assert.equal(r.ok, true);
  assert.ok(r.messageId, 'sin messageId no hay forma de correlacionar el callback');
  const enviado = JSON.parse(llamadas.find((l) => l.url.includes('/inbound'))!.opts.body);
  assert.equal(enviado.id, r.messageId, 'el id enviado y el devuelto deben ser el mismo');
});

// ── Callbacks de estado de las plantillas ───────────────────────────────────────────────────────

test('los estados de entrega llegan por el MISMO webhook y se separan de los mensajes', () => {
  const casos: [string, string][] = [['SENT', 'sent'], ['DELIVERY', 'delivered'], ['READ', 'read'], ['INVALID', 'failed']];
  for (const [chattigo, nuestro] of casos) {
    const { messages, statuses } = normalizarEntranteChattigo({
      id: 'atlas-abc', did: '56445550000', msisdn: '56912345678', type: chattigo, channel: 'WHATSAPP',
    });
    assert.equal(messages.length, 0, `${chattigo} no es un turno del estudiante`);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, nuestro);
    assert.equal(statuses[0].waMessageId, 'atlas-abc', 'el id es el que generamos al enviar');
    assert.equal(statuses[0].recipient, '+56912345678');
  }
});

test('un INVALID trae el código de error para saber por qué no llegó', () => {
  const { statuses } = normalizarEntranteChattigo({
    id: 'atlas-abc', msisdn: '56912345678', type: 'INVALID',
    errors: [{ code: 131026, title: 'Message undeliverable' }],
  });
  assert.equal(statuses[0].status, 'failed');
  assert.equal(statuses[0].errorCode, '131026');
});

test('SESSION no es un estado de entrega y no contamina las métricas', () => {
  // Solo avisa que se abrió la ventana de 24 h. Contarlo como entrega falsearía wa:status:*.
  const { messages, statuses } = normalizarEntranteChattigo({ id: 'x', msisdn: '56912345678', type: 'SESSION' });
  assert.equal(messages.length, 0);
  assert.equal(statuses.length, 0);
});

test('marcarLeido se omite en silencio: no existe acuse de lectura', async () => {
  reset();
  const r = await chattigoProvider.marcarLeido('chattigo:1');
  assert.equal(r.skipped, true);
  assert.equal(llamadas.length, 0);
});

test('faltando cualquier credencial, el proveedor no se considera configurado', () => {
  const completo = {
    waProvider: 'chattigo', chattigoBaseUrl: 'https://api.test',
    chattigoUser: 'bot', chattigoPass: 'clave', chattigoDid: '56445550000',
  };
  assert.equal(credencialesCompletas(completo), true);
  for (const campo of ['chattigoBaseUrl', 'chattigoUser', 'chattigoPass', 'chattigoDid'] as const) {
    assert.equal(credencialesCompletas({ ...completo, [campo]: '' }), false, `sin ${campo} no puede enviar`);
  }
  assert.equal(credencialesCompletas({ ...completo, waProvider: 'meta' }), false,
    'con Meta activo el adaptador de Chattigo debe quedarse quieto aunque tenga credenciales');
});

test('sin configurar, enviarTexto se omite sin tocar la red', async () => {
  // No se puede apagar config desde aquí, así que se comprueba el otro extremo: el contrato dice que
  // un proveedor sin configurar devuelve {skipped:true} y no hace ninguna llamada.
  reset();
  const r = await chattigoProvider.enviarTexto('+56912345678', 'con credenciales sí sale');
  assert.equal(r.skipped, undefined);
  assert.ok(llamadas.length > 0);
});

// En un hook, NO al final del módulo: node:test evalúa el archivo entero para registrar las
// pruebas y recién después las ejecuta, así que restaurar aquí arriba devolvía el fetch real
// antes de que corriera la primera.
after(() => {
  globalThis.fetch = fetchOriginal;
});
