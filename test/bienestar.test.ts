import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Contención ante señal de riesgo vital en los flujos deterministas.
//
// EL CASO REAL: en el piloto alguien escribió "tengo pensamientos suicidas" en el campo del NOMBRE
// durante el registro. El registro lo aceptó como nombre, siguió pidiendo el apellido, y la frase
// quedó guardada en su ficha —habría salido impresa en un certificado. El protocolo del prompt no
// se activó porque ese mensaje nunca llegó al modelo.
//
// Estas pruebas cuidan las dos mitades del problema: que la señal se detecte, y que un uso figurado
// NO dispare una contención. Lo segundo importa tanto como lo primero: una contención que llega
// cuando no corresponde le enseña a la persona a ignorarla.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});

const { detectarSenalRiesgo, manejarBienestar } = await import('../src/flows/bienestar');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK, enviarBotones: async () => OK, enviarLista: async () => OK,
    enviarDocumento: async () => OK, marcarLeido: async () => OK, descargarMedia: async () => null,
  };
  return { p, textos };
}

let n = 0, nWa = 0;
const nuevo = () => `+5690013${String(++nWa).padStart(4, '0')}`;
const texto = (from: string, t: string): InboundMessage =>
  ({ waMessageId: 'w' + ++n, from, timestamp: new Date(), type: 'text', text: t });

// ── Detección ──────────────────────────────────────────────────────────────

test('detecta expresiones inequívocas, con y sin acentos', () => {
  const casos = [
    'Nicolas Tengo Pensamientos Suicidas Y Weas', // el caso literal del piloto, en el campo nombre
    'tengo pensamientos suicidas',
    'tengo ideas suicidas',
    'quiero suicidarme',
    'me quiero matar',
    'me voy a matar',
    'ya no quiero vivir',
    'no quiero seguir viviendo',
    'quiero quitarme la vida',
    'estoy pensando en acabar con mi vida',
    'no le veo sentido a seguir viviendo',
  ];
  for (const c of casos) assert.equal(detectarSenalRiesgo(c), 'suicidio', c);
});

test('detecta autolesión', () => {
  for (const c of ['quiero hacerme daño', 'me quiero cortar', 'me estoy cortando']) {
    assert.equal(detectarSenalRiesgo(c), 'autolesion', c);
  }
});

test('un uso figurado NO dispara contención', () => {
  // En Chile esto es habla cotidiana. Interrumpir el curso acá sería un error, y repetido enseña a
  // ignorar el mensaje cuando de verdad importe.
  const figurados = [
    'me quiero morir de risa con esto',
    'me muero de hambre, sigo después',
    'me quiero morir de vergüenza, respondí cualquier cosa',
    'lo hago para matar el tiempo',
    'me muero de ganas de terminar el curso',
    'esta cápsula me mata de sueño',
  ];
  for (const c of figurados) assert.equal(detectarSenalRiesgo(c), null, c);
});

test('el contenido del curso no dispara contención', () => {
  // La microcápsula 7 habla de diagnósticos médicos, emergencias y consecuencias de equivocarse.
  const delCurso = [
    'Interpretar un diagnóstico médico personal',
    'Actuar ante una emergencia',
    '¿qué pasa si esta información está equivocada?',
    'quiero saber qué verificar antes de decidir',
    'no quiero seguir con esta microcápsula, prefiero otra',
  ];
  for (const c of delCurso) assert.equal(detectarSenalRiesgo(c), null, c);
});

test('texto vacío o vacío de contenido no dispara nada', () => {
  for (const c of ['', '   ', 'ok', '1']) assert.equal(detectarSenalRiesgo(c), null, JSON.stringify(c));
});

// ── Comportamiento del interceptor ─────────────────────────────────────────

test('consume el turno y entrega ayuda real de Chile', async () => {
  const de = nuevo();
  const { p, textos } = fakeProvider();
  const r = await manejarBienestar(texto(de, 'tengo pensamientos suicidas'), p);

  assert.equal(r.handled, true, 'el mensaje NO sigue al registro: no se guarda como nombre');
  assert.equal(textos.length, 1);
  assert.match(textos[0], /\*4141\*/, 'la línea de prevención del suicidio');
  assert.match(textos[0], /600 360 7777/, 'Salud Responde');
  assert.match(textos[0], /131/, 'emergencia inmediata');
  assert.match(textos[0], /No soy una persona/, 'no se hace pasar por alguien que puede acompañar');
  assert.match(textos[0], /alguien de confianza/);
  assert.doesNotMatch(textos[0], /microc[áa]psula|curso te espera.*continuar\b/i);
  assert.match(textos[0], /no hay ning[úu]n apuro/, 'no la empuja a seguir el curso');
});

test('un mensaje normal no lo intercepta', async () => {
  const de = nuevo();
  const { p, textos } = fakeProvider();
  const r = await manejarBienestar(texto(de, 'hola, quiero empezar el curso'), p);
  assert.equal(r.handled, false);
  assert.equal(textos.length, 0);
});

test('si insiste, no repite el mismo texto completo como una máquina', async () => {
  const de = nuevo();
  const { p, textos } = fakeProvider();
  await manejarBienestar(texto(de, 'quiero suicidarme'), p);
  await manejarBienestar(texto(de, 'ya no quiero vivir'), p);

  assert.equal(textos.length, 2);
  assert.notEqual(textos[0], textos[1]);
  assert.ok(textos[1].length < textos[0].length, 'la segunda es breve');
  assert.match(textos[1], /\*4141\*/, 'pero los números siguen ahí, que es lo que no puede faltar');
  assert.match(textos[1], /Sigo acá/);
});

test('cada persona tiene su propio estado', async () => {
  const a = nuevo(), b = nuevo();
  const { p, textos } = fakeProvider();
  await manejarBienestar(texto(a, 'quiero suicidarme'), p);
  await manejarBienestar(texto(b, 'quiero suicidarme'), p);
  assert.equal(textos[0], textos[1], 'la segunda persona recibe el mensaje completo, no el breve');
});

test('también intercepta la respuesta a un botón', async () => {
  // El cuestionario y la práctica se responden con botones y listas: el título elegido es texto.
  const de = nuevo();
  const { p, textos } = fakeProvider();
  const msg: InboundMessage = {
    waMessageId: 'w' + ++n, from: de, timestamp: new Date(), type: 'interactive',
    interactiveReplyId: 'resp:x', interactiveReplyTitle: 'me quiero matar',
  };
  assert.equal((await manejarBienestar(msg, p)).handled, true);
  assert.match(textos[0], /4141/);
});
