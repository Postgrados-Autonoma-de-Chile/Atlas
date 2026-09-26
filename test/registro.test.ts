import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Flujo de registro conversacional (Fase 3): consentimiento → nombre → apellido → email →
// confirmación → creación atómica. Repositorio de personas EN MEMORIA (mockeado) y provider falso.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

// BD "disponible" para que el flujo corra; el repo real se reemplaza por un Map en memoria.
mock.module('../src/store/db.ts', {
  namedExports: {
    dbEnabled: () => true,
    dbInsertAudit: async () => {},
    getPool: () => null,
  },
});

const personasMem = new Map<string, any>();
mock.module('../src/store/personas.ts', {
  namedExports: {
    buscarPersonaPorWaId: async (waId: string) => personasMem.get(waId) ?? null,
    crearPersonaRegistrada: async (reg: any) => {
      const p = { id: 'p-' + (personasMem.size + 1), nombre: reg.nombre, apellido: reg.apellido, email: reg.email, emailVerificado: false };
      personasMem.set(reg.waId, p);
      return p;
    },
    registrarOptOut: async () => true,
  },
});

const { manejarRegistro } = await import('../src/flows/registro');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };

function fakeProvider() {
  const textos: string[] = [];
  const botones: { cuerpo: string; ids: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake',
    configurado: () => true,
    enviarTexto: async (_to, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async (_to, cuerpo, bs) => (botones.push({ cuerpo, ids: bs.map((b) => b.id) }), OK),
    enviarLista: async () => OK,
    enviarDocumento: async () => OK,
    marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, textos, botones };
}

let n = 0;
const texto = (from: string, t: string): InboundMessage =>
  ({ waMessageId: 'wamid.r' + ++n, from, timestamp: new Date(), type: 'text', text: t });
const boton = (from: string, id: string, titulo: string): InboundMessage =>
  ({ waMessageId: 'wamid.r' + ++n, from, timestamp: new Date(), type: 'interactive', interactiveReplyId: id, interactiveReplyTitle: titulo });

test('flujo feliz completo: consentimiento → nombre → apellido → email → confirmación → persona creada', async () => {
  const { p, textos, botones } = fakeProvider();
  const from = '+56900010001';

  // 1) primer contacto → botones de consentimiento
  let r = await manejarRegistro(texto(from, 'hola'), p);
  assert.equal(r.handled, true);
  assert.equal(botones.length, 1);
  assert.deepEqual(botones[0].ids, ['reg_si', 'reg_no']);

  // 2) acepta → pide nombre
  r = await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /nombre/i);

  // 3) nombre válido → pide apellido (saludando por nombre)
  r = await manejarRegistro(texto(from, 'rodrigo'), p);
  assert.match(textos.at(-1)!, /Rodrigo/);
  assert.match(textos.at(-1)!, /apellido/i);

  // 4) apellido → pide email
  r = await manejarRegistro(texto(from, 'Palma'), p);
  assert.match(textos.at(-1)!, /correo/i);

  // 5) email inválido → reintento
  r = await manejarRegistro(texto(from, 'no-es-correo'), p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /no parece válido/i);

  // 6) email válido → botones de confirmación con el correo normalizado
  r = await manejarRegistro(texto(from, ' Rodrigo.Palma@UAUTONOMA.CL '), p);
  assert.deepEqual(botones.at(-1)!.ids, ['email_ok', 'email_no']);
  assert.match(botones.at(-1)!.cuerpo, /rodrigo\.palma@uautonoma\.cl/);

  // 7) confirma → persona creada + bienvenida
  r = await manejarRegistro(boton(from, 'email_ok', 'Sí, es correcto'), p);
  assert.equal(r.handled, true);
  assert.equal(r.persona?.nombre, 'Rodrigo');
  assert.match(textos.at(-1)!, /registrado/i);
  assert.equal(personasMem.get(from)?.apellido, 'Palma');

  // 8) siguiente mensaje: ya registrado → el flujo NO consume (pasa al tutor) y entrega la persona
  r = await manejarRegistro(texto(from, 'hola de nuevo'), p);
  assert.equal(r.handled, false);
  assert.equal(r.persona?.id, personasMem.get(from).id);
});

test('rechazo del consentimiento: mensaje amable y luego pasa al tutor sin insistir', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900010002';

  await manejarRegistro(texto(from, 'hola'), p); // ofrece consentimiento
  let r = await manejarRegistro(boton(from, 'reg_no', 'Ahora no'), p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /cuando quieras/i);

  // Mensajes posteriores no re-ofrecen (van al tutor)…
  r = await manejarRegistro(texto(from, '¿qué cursos hay?'), p);
  assert.equal(r.handled, false);

  // …hasta que la persona lo pide explícitamente.
  r = await manejarRegistro(texto(from, 'quiero registrarme'), p);
  assert.equal(r.handled, true);
});

test('nombre inválido 3 veces: pausa el registro y deja pasar el mensaje al tutor', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900010003';

  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);
  await manejarRegistro(texto(from, '123'), p); // intento 1
  await manejarRegistro(texto(from, '456'), p); // intento 2
  const r = await manejarRegistro(texto(from, '789'), p); // tercero → pausa
  assert.equal(r.handled, false, 'el mensaje sigue al tutor');
  assert.match(textos.at(-1)!, /retomamos/i);
});

test('doble-tap de un botón durante la captura NO se persiste como nombre (revisión F9.1)', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900010005';

  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p); // etapa: nombre
  const r = await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p); // doble-tap del botón
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /por texto/i, 'pide texto en vez de guardar "Acepto" como nombre');
  await manejarRegistro(texto(from, 'Rodrigo'), p);
  assert.match(textos.at(-1)!, /Rodrigo/, 'el nombre real se captura después sin haber gastado reintentos');
});

test('consentimiento: re-ofrece UNA vez ante texto libre; a la segunda pausa y el mensaje va al tutor', async () => {
  const { p, botones } = fakeProvider();
  const from = '+56900010006';

  await manejarRegistro(texto(from, 'hola'), p); // oferta 1
  let r = await manejarRegistro(texto(from, '¿de qué trata el curso?'), p);
  assert.equal(r.handled, true, 're-oferta única');
  assert.equal(botones.length, 2);
  r = await manejarRegistro(texto(from, '¿y quién lo dicta?'), p);
  assert.equal(r.handled, false, 'a la segunda, la pregunta llega al tutor');
  assert.equal(botones.length, 2, 'sin tercera oferta');
});

test('corregir el email: vuelve a pedirlo', async () => {
  const { p, textos, botones } = fakeProvider();
  const from = '+56900010004';

  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);
  await manejarRegistro(texto(from, 'Magdalena'), p);
  await manejarRegistro(texto(from, 'Rojas'), p);
  await manejarRegistro(texto(from, 'magda@x.cl'), p);
  assert.deepEqual(botones.at(-1)!.ids, ['email_ok', 'email_no']);
  const r = await manejarRegistro(boton(from, 'email_no', 'Corregirlo'), p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /correo/i);
});

// ── Hallazgo en producción (F14, 22-sep-2026): al revisar el panel de cohorte aparecieron
// personas registradas con "Hola, Cuál Sería El Valor ? Necesito Saber El Valor" como nombre, un
// correo pegado en la respuesta, y nombres duplicados como "Gabriela Silva Silva Arancibia". La
// spec original de validarNombre solo exigía "sin dígitos": estos casos son texto libre real que
// pasó esa validación. ──

test('una pregunta no se persiste como nombre: se pide de nuevo, igual que cualquier dato inválido', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900010010';
  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);

  const r = await manejarRegistro(texto(from, 'Hola, Cuál Sería El Valor ? Necesito Saber El Valor'), p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /no parece un nombre/i);
  assert.equal(personasMem.get(from), undefined, 'no se creó ninguna persona con ese "nombre"');
});

test('un correo pegado en la respuesta del nombre se rechaza, no se guarda tal cual', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900010011';
  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);

  const r = await manejarRegistro(texto(from, 'Sara Fredes Hfredes@indap.cl Ahí Está El Apellido'), p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /no parece un nombre/i);
});

test('nombre completo con apellidos repetido en la pregunta de apellido: no queda duplicado', async () => {
  // El caso real: "Gabriela Silva" (nombre) + "Silva Arancibia" (apellido) se mostraba como
  // "Gabriela Silva Silva Arancibia". Con la limpieza, el apellido guardado es solo lo nuevo.
  const { p } = fakeProvider();
  const from = '+56900010012';
  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);
  await manejarRegistro(texto(from, 'Gabriela Silva'), p);
  await manejarRegistro(texto(from, 'Silva Arancibia'), p);
  await manejarRegistro(texto(from, 'gabriela.silva@correo.cl'), p);
  await manejarRegistro(boton(from, 'email_ok', 'Sí, es correcto'), p);

  assert.equal(personasMem.get(from)?.nombre, 'Gabriela Silva');
  assert.equal(personasMem.get(from)?.apellido, 'Arancibia', 'sin repetir "Silva"');
});

test('si el apellido repite TODO el nombre, no se guarda un apellido vacío: se vuelve a pedir', async () => {
  // Caso real: nombre="Samuel Trangulado", apellido="Samuel" → tras limpiar, apellido queda vacío.
  // Guardar "" sería peor que preguntar de nuevo, así que cuenta como inválido.
  const { p, textos } = fakeProvider();
  const from = '+56900010013';
  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);
  await manejarRegistro(texto(from, 'Samuel Trangulado'), p);

  const r = await manejarRegistro(texto(from, 'Samuel'), p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /no me calza/i);
  assert.equal(personasMem.get(from), undefined);
});

test('una credencial o profesión pegada al apellido (muchas palabras) se rechaza', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900010014';
  await manejarRegistro(texto(from, 'hola'), p);
  await manejarRegistro(boton(from, 'reg_si', 'Acepto'), p);
  await manejarRegistro(texto(from, 'Magister En Derecho Penal Y Procesal Penal Urbina Reyes'), p);
  assert.match(textos.at(-1)!, /no parece un nombre/i);
});
