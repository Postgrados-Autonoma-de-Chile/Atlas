import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Alternativas que no caben en una fila de lista de WhatsApp.
//
// PASÓ EN PRODUCCIÓN: la práctica de la microcápsula 1 mostró la alternativa A cortada en
// "…para que Carolina pueda revi". La descripción de una fila admite 72 caracteres y esa tiene 79.
//
// El caso grave es la microcápsula 3: su mejor solicitud tiene 166 caracteres y se perdían dos
// tercios, justo en la actividad donde LEER la solicitud completa es el aprendizaje. Elegir entre
// alternativas que no se pueden leer no es una actividad, es una lotería.
//
// Regla del proyecto, ya aplicada a los botones de 20 caracteres y a la pregunta de 16 regiones: si
// el contenido no cabe en la afordancia, se cambia la afordancia — no se recorta el contenido.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const LARGA = 'Comparar criterios y organizar alternativas para que Carolina pueda revisarlas.';
const SOLICITUD = 'Quiero comparar capacitaciones para mejorar mis oportunidades laborales. Trabajo de día y necesito modalidad online. Indícame criterios para compararlas en una tabla.';

/** Opciones de la pregunta activa. Se cambia entre pruebas para variar el caso. */
let opciones = [
  { id: 'o1', orden: 1, texto: LARGA, esCorrecta: true },
  { id: 'o2', orden: 2, texto: 'Elegir automáticamente el curso “correcto” sin que Carolina revise nada.', esCorrecta: false },
  { id: 'o3', orden: 3, texto: 'Garantizar que una capacitación le conseguirá un empleo.', esCorrecta: false },
  { id: 'o4', orden: 4, texto: 'Decidir cuánto dinero debería gastar.', esCorrecta: false },
];

const pregunta = () => ({
  id: 'q1', orden: 1, tipo: 'seleccion_multiple', enunciado: '¿Qué puede hacer una IA en este caso?',
  explicacion: 'La IA puede ayudar a ordenar y comparar información.',
  sinRespuestaCorrecta: false, itemTexto: null, opciones,
});

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/evaluaciones.ts', {
  namedExports: {
    quizDeLeccion: async () => ({ id: 'z1', titulo: 'Lo intento' }),
    quizzesPendientes: async () => 0,
    quizParaIniciar: async () => ({ quizId: 'z1', titulo: 'Lo intento', enrollmentId: 'e1' }),
    iniciarAttempt: async () => ({
      attemptId: 'a1', quizId: 'z1', titulo: 'Lo intento', intentoN: 1, total: 1,
      primera: pregunta(),
      interaccion: { tipo: 'seleccion_unica', consigna: 'Elige la alternativa correcta.', retroalimentacion: 'Criterio.', minimoRequerido: 1 },
    }),
    registrarRespuesta: async () => null,
  },
});

const { marcarQuizPendiente, iniciarQuizPendiente } = await import('../src/flows/evaluacion');
import type { MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const listas: { cuerpo: string; filas: { titulo: string; descripcion?: string }[] }[] = [];
  const botones: { cuerpo: string; titulos: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarLista: async (_t, cuerpo, _b, os) => (listas.push({ cuerpo, filas: os.map((o) => ({ titulo: o.titulo, descripcion: o.descripcion })) }), OK),
    enviarBotones: async (_t, cuerpo, bs) => (botones.push({ cuerpo, titulos: bs.map((b) => b.titulo) }), OK),
    enviarPlantilla: async () => OK, enviarDocumento: async () => OK,
    marcarLeido: async () => OK, descargarMedia: async () => null,
  };
  return { p, textos, listas, botones };
}

let nWa = 0;
let DE = '+56900150001';
const nuevo = () => (DE = `+5690015${String(++nWa).padStart(4, '0')}`);
const PERSONA = { id: 'p1', nombre: 'Rodrigo' } as any;

async function enviar() {
  nuevo();
  const f = fakeProvider();
  await marcarQuizPendiente(DE, false);
  await iniciarQuizPendiente(DE, PERSONA, f.p);
  return f;
}

test('la alternativa larga llega COMPLETA, en el cuerpo del mensaje', async () => {
  opciones = [
    { id: 'o1', orden: 1, texto: LARGA, esCorrecta: true },
    { id: 'o2', orden: 2, texto: 'Elegir automáticamente el curso “correcto” sin que Carolina revise nada.', esCorrecta: false },
  ];
  const { listas } = await enviar();
  assert.equal(listas.length, 1);
  assert.match(listas[0].cuerpo, /revisarlas\./, 'termina completa, no en "revi"');
  assert.ok(listas[0].cuerpo.includes(LARGA), 'el texto íntegro está en el cuerpo');
  assert.match(listas[0].cuerpo, /\*A\.\*/, 'y enumerada con la letra con que se responde');
});

test('cuando el texto va en el cuerpo, las filas NO repiten un recorte', async () => {
  opciones = [
    { id: 'o1', orden: 1, texto: LARGA, esCorrecta: true },
    { id: 'o2', orden: 2, texto: 'Decidir cuánto dinero debería gastar.', esCorrecta: false },
  ];
  const { listas } = await enviar();
  assert.deepEqual(listas[0].filas.map((f) => f.titulo), ['A', 'B']);
  for (const f of listas[0].filas) {
    assert.equal(f.descripcion, undefined, 'sin descripción: el cuerpo ya trae el texto entero');
  }
});

test('la solicitud de 166 caracteres de la microcápsula 3 no pierde nada', async () => {
  // Es el caso que importa: la actividad consiste en LEER las solicitudes y comparar.
  opciones = [
    { id: 'o1', orden: 1, texto: SOLICITUD, esCorrecta: true },
    { id: 'o2', orden: 2, texto: 'Quiero un curso.', esCorrecta: false },
  ];
  const { listas } = await enviar();
  assert.ok(listas[0].cuerpo.includes(SOLICITUD));
  assert.match(listas[0].cuerpo, /en una tabla\./);
});

test('si todas caben, se conserva la lista con la descripción por fila', async () => {
  // No hay que empeorar el caso normal: con opciones cortas, verlas en la fila es mejor.
  opciones = [
    { id: 'o1', orden: 1, texto: 'IA puede ayudar', esCorrecta: true },
    { id: 'o2', orden: 2, texto: 'IA con verificación', esCorrecta: false },
    { id: 'o3', orden: 3, texto: 'fuente o persona competente', esCorrecta: false },
    { id: 'o4', orden: 4, texto: 'Ninguna de las anteriores', esCorrecta: false },
  ];
  const { listas } = await enviar();
  assert.deepEqual(listas[0].filas.map((f) => f.descripcion), [
    'IA puede ayudar', 'IA con verificación', 'fuente o persona competente', 'Ninguna de las anteriores',
  ]);
  assert.doesNotMatch(listas[0].cuerpo, /\*A\.\*/, 'sin enumerar: no hace falta');
});

test('con dos opciones cortas siguen siendo botones', async () => {
  opciones = [
    { id: 'o1', orden: 1, texto: 'Verdadero', esCorrecta: true },
    { id: 'o2', orden: 2, texto: 'Falso', esCorrecta: false },
  ];
  const { botones, listas } = await enviar();
  assert.equal(listas.length, 0);
  assert.deepEqual(botones[0].titulos, ['Verdadero', 'Falso']);
});

test('con un solo ítem no se numera la pregunta', async () => {
  // "Pregunta 1 de 1" es ruido, y en la microcápsula 1 la práctica es exactamente una.
  opciones = [
    { id: 'o1', orden: 1, texto: LARGA, esCorrecta: true },
    { id: 'o2', orden: 2, texto: 'Decidir cuánto dinero debería gastar.', esCorrecta: false },
  ];
  const { listas } = await enviar();
  assert.doesNotMatch(listas[0].cuerpo, /1 de 1/);
  assert.match(listas[0].cuerpo, /\*Pregunta\*/);
});
