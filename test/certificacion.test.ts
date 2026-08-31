import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Flujo de certificación (Fase 8): RUT validado + confirmación, código por correo, emisión con
// folio, envío del PDF y estados. Stores/mailer/pdf SIMULADOS; el LLM no participa en nada de esto.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let cert: any = null;
let rutResultado: 'ok' | 'rut_en_uso' | 'error' = 'ok';
let tieneRutFlag = false;
let emailVerificado = false;
let mailOk = true;
const correos: any[] = [];

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/certificados.ts', {
  namedExports: {
    certificadoDePersona: async () => cert,
    marcarDatosPendientes: async () => { if (cert?.estado === 'elegible') cert.estado = 'datos_pendientes'; },
    emitir: async () => {
      if (!cert) return null;
      if (cert.estado === 'elegible' || cert.estado === 'datos_pendientes') {
        cert.estado = 'emitido';
        cert.folio = 'ATLAS-2026-0001';
        cert.codigo = 'a1b2c3d4e5f60718';
      }
      return cert.folio ? { folio: cert.folio, codigo: cert.codigo ?? '' } : null;
    },
    marcarEnviado: async () => { if (cert?.estado === 'emitido') cert.estado = 'enviado'; },
  },
});
mock.module('../src/store/personas.ts', {
  namedExports: {
    tieneRut: async () => tieneRutFlag,
    guardarRut: async () => (rutResultado === 'ok' ? ((tieneRutFlag = true), 'ok') : rutResultado),
    marcarEmailVerificado: async () => { emailVerificado = true; },
    buscarPersonaPorWaId: async () => null,
    crearPersonaRegistrada: async () => null,
    registrarOptOut: async () => true,
    registrarOptIn: async () => true,
  },
});
mock.module('../src/cert/mailer.ts', {
  namedExports: { enviarCorreo: async (o: any) => (correos.push(o), { ok: mailOk }) },
});
mock.module('../src/cert/pdf.ts', {
  namedExports: { generarCertificadoPdf: async () => Buffer.from('%PDF-fake') },
});

const { manejarCertificacion, generarCodigo } = await import('../src/flows/certificacion');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const botones: { cuerpo: string; ids: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async (_t, cuerpo, bs) => (botones.push({ cuerpo, ids: bs.map((b) => b.id) }), OK),
    enviarLista: async () => OK,
    enviarDocumento: async () => OK,
    marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, textos, botones };
}

let n = 0;
const texto = (from: string, t: string): InboundMessage => ({ waMessageId: 'wamid.c' + ++n, from, timestamp: new Date(), type: 'text', text: t });
const boton = (from: string, id: string, titulo: string): InboundMessage => ({ waMessageId: 'wamid.c' + ++n, from, timestamp: new Date(), type: 'interactive', interactiveReplyId: id, interactiveReplyTitle: titulo });
const PERSONA = { id: 'p1', nombre: 'Rodrigo', apellido: 'Palma', email: 'rodrigo.palma@uautonoma.cl', emailVerificado: false } as any;

const reset = (estadoCert: string | null = 'elegible') => {
  cert = estadoCert ? { id: 'cert1', estado: estadoCert, folio: estadoCert === 'enviado' ? 'ATLAS-2026-0009' : null, codigo: estadoCert === 'enviado' ? 'ffffffffffffffff' : null, cursoNombre: 'IA en la vida cotidiana', minutos: 58 } : null;
  rutResultado = 'ok';
  tieneRutFlag = false;
  emailVerificado = false;
  mailOk = true;
  correos.length = 0;
};
const ultimoCodigo = () => correos.at(-1)!.html.match(/(\d{6})/)![1];

test('generarCodigo: 6 dígitos', () => {
  for (let i = 0; i < 20; i++) assert.match(generarCodigo(), /^\d{6}$/);
});

test('sin curso completado: "certificado" no se intercepta (el tutor explica el avance)', async () => {
  reset(null);
  const { p } = fakeProvider();
  const r = await manejarCertificacion(texto('+56900060001', 'quiero mi certificado'), PERSONA, p);
  assert.equal(r.handled, false);
});

test('camino feliz: certificado → RUT → confirmación → código → emisión + PDF por correo', async () => {
  reset();
  const { p, textos, botones } = fakeProvider();
  const from = '+56900060002';

  // Inicio: pide RUT
  let r = await manejarCertificacion(texto(from, 'quiero mi certificado 🎓'), PERSONA, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /RUT/);
  assert.equal(cert.estado, 'datos_pendientes');

  // RUT inválido → reintento
  r = await manejarCertificacion(texto(from, '12345678-9'), PERSONA, p);
  assert.match(textos.at(-1)!, /no parece válido/i);

  // RUT válido → confirmación con botones
  r = await manejarCertificacion(texto(from, '12.345.678-5'), PERSONA, p);
  assert.deepEqual(botones.at(-1)!.ids, ['rut_ok', 'rut_no']);
  assert.match(botones.at(-1)!.cuerpo, /12345678-5/);

  // Confirma → código enviado al correo enmascarado
  r = await manejarCertificacion(boton(from, 'rut_ok', 'Sí, es correcto'), PERSONA, p);
  assert.equal(correos.length, 1, 'correo con el código');
  assert.match(correos[0].to, /rodrigo\.palma@uautonoma\.cl/);
  assert.match(textos.at(-1)!, /r\*\*\*a@uautonoma\.cl/, 'el email va enmascarado por WhatsApp');

  // Código incorrecto → reintento; correcto → emite, envía PDF y confirma con folio
  r = await manejarCertificacion(texto(from, '000000'), PERSONA, p);
  assert.match(textos.at(-1)!, /no coincide/i);
  r = await manejarCertificacion(texto(from, ultimoCodigo()), PERSONA, p);
  assert.equal(r.handled, true);
  assert.equal(emailVerificado, true);
  assert.equal(cert.estado, 'enviado');
  assert.equal(correos.length, 2, 'segundo correo: el certificado');
  assert.equal(correos[1].adjuntos[0].filename, 'certificado-ATLAS-2026-0001.pdf');
  assert.ok(correos[1].adjuntos[0].content.length > 0);
  assert.match(textos.at(-1)!, /ATLAS-2026-0001/);

  // Ya enviado: pedirlo de nuevo informa el folio sin re-emitir
  r = await manejarCertificacion(texto(from, 'certificado'), PERSONA, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /ya fue emitido/i);
});

test('con RUT previo: va directo al código de verificación', async () => {
  reset();
  tieneRutFlag = true;
  const { p, textos } = fakeProvider();
  const from = '+56900060003';
  const r = await manejarCertificacion(texto(from, 'certificado'), PERSONA, p);
  assert.equal(r.handled, true);
  assert.equal(correos.length, 1);
  assert.match(textos.at(-1)!, /código de 6 dígitos/i);
});

test('RUT en uso por otra persona: deriva al equipo y NO certifica (antisuplantación)', async () => {
  reset();
  rutResultado = 'rut_en_uso';
  const { p, textos } = fakeProvider();
  const from = '+56900060004';
  await manejarCertificacion(texto(from, 'certificado'), PERSONA, p);
  await manejarCertificacion(texto(from, '12345678-5'), PERSONA, p);
  const r = await manejarCertificacion(boton(from, 'rut_ok', 'Sí, es correcto'), PERSONA, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /otra cuenta/i);
  assert.equal(cert.estado, 'datos_pendientes', 'no se emitió');
  assert.equal(correos.length, 0, 'sin código ni certificado');
});

test('RUT inválido tres veces: pausa y se retoma con "certificado"', async () => {
  reset();
  const { p, textos } = fakeProvider();
  const from = '+56900060005';
  await manejarCertificacion(texto(from, 'certificado'), PERSONA, p);
  await manejarCertificacion(texto(from, 'abc'), PERSONA, p);
  await manejarCertificacion(texto(from, '111'), PERSONA, p);
  const r = await manejarCertificacion(texto(from, 'xyz'), PERSONA, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /pausa/i);
  const despues = await manejarCertificacion(texto(from, 'hola, ¿qué era un sesgo?'), PERSONA, p);
  assert.equal(despues.handled, false, 'sin flujo activo, la duda va al tutor');
});

test('reenviar: genera un código nuevo', async () => {
  reset();
  tieneRutFlag = true;
  const { p } = fakeProvider();
  const from = '+56900060006';
  await manejarCertificacion(texto(from, 'certificado'), PERSONA, p);
  const primero = ultimoCodigo();
  await manejarCertificacion(texto(from, 'reenviar'), PERSONA, p);
  assert.equal(correos.length, 2);
  const segundo = ultimoCodigo();
  const r = await manejarCertificacion(texto(from, segundo), PERSONA, p);
  assert.equal(cert.estado, 'enviado', `el código vigente emite (previo=${primero})`);
  assert.equal(r.handled, true);
});

test('fallo del correo del certificado: queda emitido con folio y avisa reintento', async () => {
  reset();
  tieneRutFlag = true;
  const { p, textos } = fakeProvider();
  const from = '+56900060007';
  await manejarCertificacion(texto(from, 'certificado'), PERSONA, p);
  const codigo = ultimoCodigo();
  mailOk = false; // el correo del certificado fallará
  await manejarCertificacion(texto(from, codigo), PERSONA, p);
  assert.equal(cert.estado, 'emitido', 'emitido pero no enviado');
  assert.match(textos.at(-1)!, /no pude enviarlo/i);
  // Reintento: 'certificado' con estado emitido → re-envía sin nuevo folio
  mailOk = true;
  await manejarCertificacion(texto(from, 'certificado'), PERSONA, p);
  assert.equal(cert.estado, 'enviado');
  assert.equal(cert.folio, 'ATLAS-2026-0001');
});

// ── Ingreso del código: robustez (hallazgo del piloto) ──────────────────────────────────────────
//
// En la prueba real, un mensaje con la palabra "certificado" llegó mientras el flujo esperaba el
// código y recibió "Ese código no coincide 🤔" — además de consumir uno de los tres intentos. Ese
// mensaje no traía ningún código: no había nada que pudiera "no coincidir". Con tres mensajes así
// (un estudiante escribiendo "no me llegó nada", "reenvíamelo", "hola?") el flujo se cancelaba solo,
// sin que la persona hubiera errado un código jamás.
//
// Segundo problema del mismo paso: WhatsApp incluye el mensaje CITADO cuando alguien responde
// tocando "responder", así que el código llega rodeado de texto. Exigir que el mensaje entero
// fuera el código rechazaba respuestas perfectamente correctas.

// Cada prueba usa un waId propio: el estado del flujo vive en el KV por número, y una prueba que
// termina a medias (esperando el codigo) contaminaba a la siguiente.
let nWa = 0;
const llegarAlPasoDelCodigo = async () => {
  reset('datos_pendientes');
  tieneRutFlag = true;
  const wa = `+5697777${String(++nWa).padStart(4, '0')}`; // prefijo propio: +5690006* ya lo usan las pruebas de arriba
  const { p, textos } = fakeProvider();
  await manejarCertificacion(texto(wa, 'certificado'), PERSONA, p);
  return { p, textos, wa };
};

test('texto sin código NO se trata como código equivocado ni gasta intentos', async () => {
  const { p, textos, wa } = await llegarAlPasoDelCodigo();
  const codigo = ultimoCodigo();

  // Tres mensajes sin código: antes esto cancelaba el certificado.
  for (const t of ['certificado', 'no me llegó nada', 'hola?']) {
    await manejarCertificacion(texto(wa, t), PERSONA, p);
    assert.doesNotMatch(textos.at(-1)!, /no coincide/i, `"${t}" no es un código equivocado`);
  }

  // El flujo sigue vivo: el código correcto todavía funciona.
  await manejarCertificacion(texto(wa, codigo), PERSONA, p);
  assert.equal(emailVerificado, true, 'tras los mensajes sin código el flujo debe seguir aceptando el correcto');
  assert.equal(cert.estado, 'enviado');
});

test('"certificado" durante el paso del código recibe una guía, no un reproche', async () => {
  const { p, textos, wa } = await llegarAlPasoDelCodigo();
  await manejarCertificacion(texto(wa, 'Certificado'), PERSONA, p);
  assert.match(textos.at(-1)!, /6 d[ií]gitos/i);
  assert.doesNotMatch(textos.at(-1)!, /no coincide/i);
});

test('el código se reconoce aunque venga dentro del texto (respuesta citada de WhatsApp)', async () => {
  const { p, wa } = await llegarAlPasoDelCodigo();
  const codigo = ultimoCodigo();
  const citado = `Te envié un código de 6 dígitos a *r***a@gmail.com*. Escríbelo aquí\n${codigo}`;
  await manejarCertificacion(texto(wa, citado), PERSONA, p);
  assert.equal(emailVerificado, true, 'el código válido dentro de una cita debe aceptarse');
});

test('un RUT no se confunde con un código de 6 dígitos', async () => {
  const { p, textos, wa } = await llegarAlPasoDelCodigo();
  // 19864724-1 contiene "198647", pero no es un grupo de 6 dígitos aislado.
  await manejarCertificacion(texto(wa, '19864724-1'), PERSONA, p);
  assert.match(textos.at(-1)!, /6 d[ií]gitos/i, 'debe pedir el código, no decir que no coincide');
  assert.equal(emailVerificado, false);
});

test('un código de 6 dígitos REALMENTE equivocado sí gasta intentos y termina en pausa', async () => {
  const { p, textos, wa } = await llegarAlPasoDelCodigo();
  const codigo = ultimoCodigo();
  const malo = codigo === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) await manejarCertificacion(texto(wa, malo), PERSONA, p);
  assert.match(textos.at(-1)!, /pausa/i, 'tres códigos equivocados sí deben cancelar');
  assert.equal(emailVerificado, false);
});
