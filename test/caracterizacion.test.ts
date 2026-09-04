import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Cuestionario de caracterización — PRIMER paso de la experiencia según el plan curricular.
//
// FUENTE: "Cuestionario de Caracterización (Ajustado).docx" — 11 preguntas en tres secciones.
//
// Lo que estas pruebas cuidan:
//   · que el cuestionario se exija ANTES de la ruta, y que el bloqueo viva en el estado y no en
//     el prompt (el modelo no debe poder saltárselo por complacer a quien insiste);
//   · que se retome donde quedó, porque son 11 preguntas por WhatsApp y nadie las responde de una;
//   · que la pregunta de región funcione: tiene 16 opciones y las listas de WhatsApp admiten 10.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

// Cuestionario simulado con las tres formas reales: 2 opciones (botones), 5 (lista) y 16 (texto).
const PREGUNTAS = [
  { id: 'q1', codigo: 'edad', orden: 1, seccion: 'Antecedentes', enunciado: '¿Cuál es su rango de edad?',
    opciones: [1, 2, 3, 4, 5].map((i) => ({ id: `q1o${i}`, orden: i, texto: `${18 + i * 10}–${27 + i * 10} años` })) },
  { id: 'q2', codigo: 'region', orden: 2, seccion: 'Antecedentes', enunciado: '¿En qué región reside?',
    opciones: Array.from({ length: 16 }, (_, i) => ({ id: `q2o${i + 1}`, orden: i + 1, texto: `Región ${i + 1}` })) },
  { id: 'q3', codigo: 'busca_reconversion', orden: 3, seccion: 'Empleabilidad', enunciado: '¿Busca reconvertirse?',
    opciones: [{ id: 'q3o1', orden: 1, texto: 'Sí' }, { id: 'q3o2', orden: 2, texto: 'No' }] },
];

let respuestas = new Map<string, string>();
let completadaEn: string | null = null;

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/caracterizacion.ts', {
  namedExports: {
    totalPreguntas: async () => PREGUNTAS.length,
    respondidas: async () => respuestas.size,
    siguientePregunta: async () => PREGUNTAS.find((p) => !respuestas.has(p.id)) ?? null,
    guardarRespuesta: async (_p: string, qid: string, oid: string) => (respuestas.set(qid, oid), true),
    cerrarSiCompleta: async () => {
      if (respuestas.size === PREGUNTAS.length) completadaEn = new Date().toISOString();
      return completadaEn !== null;
    },
    estaCompleta: async () => completadaEn !== null,
    perfil: async () => ({}),
  },
});

const { manejarCaracterizacion, interpretarRespuesta } = await import('../src/flows/caracterizacion');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const listas: { cuerpo: string; filas: { id: string; titulo: string }[] }[] = [];
  const botones: { cuerpo: string; ids: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async (_t, cuerpo, bs) => (botones.push({ cuerpo, ids: bs.map((b) => b.id) }), OK),
    enviarLista: async (_t, cuerpo, _b, os) => (listas.push({ cuerpo, filas: os.map((o) => ({ id: o.id, titulo: o.titulo })) }), OK),
    enviarDocumento: async () => OK,
    marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, textos, listas, botones };
}

// Cada prueba usa un waId propio: el estado del cuestionario vive en el KV por número, y el
// almacén en memoria persiste entre pruebas — sin esto, una prueba que deja el cuestionario a
// medias hace que la siguiente entre por la rama "en curso".
let n = 0, nWa = 0;
let DE = '+56900080001';
const nuevoNumero = () => (DE = `+5690008${String(++nWa).padStart(4, '0')}`);
const texto = (t: string): InboundMessage =>
  ({ waMessageId: 'wamid.c' + ++n, from: DE, timestamp: new Date(), type: 'text', text: t });
const fila = (id: string, titulo: string): InboundMessage =>
  ({ waMessageId: 'wamid.c' + ++n, from: DE, timestamp: new Date(), type: 'interactive', interactiveReplyId: id, interactiveReplyTitle: titulo });

const PERSONA = { id: 'p1', nombre: 'Rodrigo', apellido: 'Palma' } as any;
const reset = () => { respuestas = new Map(); completadaEn = null; nuevoNumero(); };

// ── Caso 1: usuario nuevo ───────────────────────────────────────────────────

test('caso 1 — un usuario nuevo que quiere empezar recibe primero el cuestionario', async () => {
  reset();
  const { p, textos, listas } = fakeProvider();
  const r = await manejarCaracterizacion(texto('quiero empezar el curso'), PERSONA, p);
  assert.equal(r.handled, true, 'el cuestionario debe interceptar antes de cualquier contenido');
  assert.match(textos[0], /3 preguntas/, 'anuncia cuántas son');
  assert.match(textos[0], /No existen respuestas correctas ni incorrectas/,
    'la introducción del documento se transcribe: declara la finalidad del uso de datos');
  assert.equal(listas.length, 1, 'la primera pregunta tiene 5 opciones: va como lista');
  assert.match(listas[0].cuerpo, /Pregunta 1 de 3/);
});

test('un mensaje cualquiera NO dispara el cuestionario', async () => {
  // Si cualquier saludo lo iniciara, no habría forma de conversar con el tutor.
  reset();
  const { p } = fakeProvider();
  const r = await manejarCaracterizacion(texto('hola, una consulta'), PERSONA, p);
  assert.equal(r.handled, false);
});

// ── Caso 2: completa la caracterización ─────────────────────────────────────

test('caso 2 — al completarlo, se cierra y se ofrece iniciar la ruta', async () => {
  reset();
  const { p, textos, listas, botones } = fakeProvider();
  await manejarCaracterizacion(texto('cuestionario'), PERSONA, p);
  await manejarCaracterizacion(fila('car:q1o1', '1'), PERSONA, p);       // pregunta 1
  await manejarCaracterizacion(texto('7'), PERSONA, p);                  // pregunta 2, por número
  await manejarCaracterizacion(fila('car:q3o1', 'Sí'), PERSONA, p);      // pregunta 3
  assert.equal(respuestas.size, 3, 'las tres respuestas quedaron guardadas');
  assert.equal(respuestas.get('q2'), 'q2o7', 'el número 7 corresponde a la séptima opción');
  assert.equal(completadaEn !== null, true, 'la caracterización queda marcada como completa');
  assert.match(textos.at(-1)!, /ya podemos partir/i);
  assert.equal(botones.length, 1, 'la pregunta de 2 opciones fue con botones');
  assert.equal(listas.length, 1);
});

test('completa, deja de interceptar: el turno sigue al tutor', async () => {
  reset();
  const { p } = fakeProvider();
  for (const q of PREGUNTAS) respuestas.set(q.id, `${q.id}o1`);
  await (await import('../src/store/caracterizacion')).cerrarSiCompleta('p1');
  const r = await manejarCaracterizacion(texto('quiero empezar el curso'), PERSONA, p);
  assert.equal(r.handled, false);
});

// ── Caso 3: abandona y vuelve ───────────────────────────────────────────────

test('caso 3 — se retoma en la pregunta donde quedó, no desde el principio', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await manejarCaracterizacion(texto('cuestionario'), PERSONA, p);
  await manejarCaracterizacion(fila('car:q1o2', '2'), PERSONA, p);
  await manejarCaracterizacion(texto('salir'), PERSONA, p);
  assert.match(textos.at(-1)!, /pregunta 2 de 3/i, 'dice exactamente dónde quedó');

  // Mismo número a propósito: es la misma persona volviendo días después.
  const seg = fakeProvider();
  await manejarCaracterizacion(texto('cuestionario'), PERSONA, seg.p);
  const todo = seg.textos.join(' ');
  assert.doesNotMatch(todo, /No existen respuestas correctas/, 'no repite la introducción');
  assert.match(todo, /Pregunta 2 de 3/, 'retoma en la 2, no en la 1');
  assert.equal(respuestas.size, 1, 'la respuesta anterior se conservó');
});

// ── Interpretación de la respuesta ──────────────────────────────────────────

test('la pregunta de 16 opciones va como texto numerado, no como lista', async () => {
  // Las listas de WhatsApp admiten 10 filas; región tiene 16. Sin este camino, la pregunta
  // simplemente no se podría hacer.
  reset();
  const { p, textos, listas } = fakeProvider();
  await manejarCaracterizacion(texto('cuestionario'), PERSONA, p);
  await manejarCaracterizacion(fila('car:q1o1', '1'), PERSONA, p);
  assert.equal(listas.length, 1, 'solo la de 5 opciones fue lista');
  const ultimo = textos.at(-1)!;
  assert.match(ultimo, /Región 16/, 'las 16 alternativas quedan visibles');
  assert.match(ultimo, /Responde con el número/);
});

test('interpretarRespuesta acepta id, número y texto exacto', () => {
  nuevoNumero();
  const ops = [{ id: 'a', texto: 'Enseñanza media' }, { id: 'b', texto: 'Profesional' }];
  assert.equal(interpretarRespuesta(fila('car:b', 'Profesional'), ops), 'b');
  assert.equal(interpretarRespuesta(texto('2'), ops), 'b');
  assert.equal(interpretarRespuesta(texto('profesional'), ops), 'b', 'sin acentos ni mayúsculas');
  assert.equal(interpretarRespuesta(texto('Enseñanza media'), ops), 'a');
});

test('interpretarRespuesta rechaza lo ambiguo en vez de adivinar', () => {
  nuevoNumero();
  // Guardar una respuesta equivocada en un instrumento de caracterización es peor que repreguntar.
  const ops = [{ id: 'a', texto: 'Ciencias sociales' }, { id: 'b', texto: 'Ciencias de la salud' }];
  assert.equal(interpretarRespuesta(texto('ciencias'), ops), null, 'prefijo que calza con dos');
  assert.equal(interpretarRespuesta(texto('99'), ops), null, 'número fuera de rango');
  assert.equal(interpretarRespuesta(texto('no sé'), ops), null);
  assert.equal(interpretarRespuesta(fila('car:zzz', 'x'), ops), null, 'id que no pertenece');
});

test('una respuesta no reconocida repregunta sin perder el avance', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await manejarCaracterizacion(texto('cuestionario'), PERSONA, p);
  const r = await manejarCaracterizacion(texto('cualquier cosa'), PERSONA, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /No pude identificar/);
  assert.equal(respuestas.size, 0, 'no se guardó nada equivocado');
});
