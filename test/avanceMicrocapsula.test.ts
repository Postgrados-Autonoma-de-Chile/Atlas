import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Caso 7: la persona termina una microcápsula y debe pasar correctamente a la siguiente.
//
// FUENTE: "Nivel 1 IA - Plan Nacional (Ajustado).docx" — «Duración total estimada de 40 a 60
// minutos, organizada en 8 microcápsulas de 5 a 7 minutos», recorridas en la ruta
// DEFINO → PREGUNTO → ORGANIZO → VERIFICO → DECIDO. El plan NO subdivide el nivel en módulos:
// las 8 microcápsulas son la secuencia, y el orden es el del documento.
//
// Dos cosas tienen que ser ciertas para que el avance sea correcto:
//   1. la secuencia cargada es la del material (orden, títulos y paso de la ruta), y
//   2. al cerrar la práctica de una microcápsula, el traspaso apunta a la siguiente — o al
//      certificado si era la última, nunca a una microcápsula que no existe.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const CURRICULO = JSON.parse(readFileSync(new URL('../curriculo/nivel1.json', import.meta.url), 'utf-8'));

// ── 1. La secuencia es la del documento ─────────────────────────────────────

test('caso 7 — las 8 microcápsulas están en el orden del documento, con su paso de la ruta', () => {
  const caps = CURRICULO.microcapsulas;
  assert.equal(caps.length, 8, 'el plan define ocho, no nueve');
  assert.deepEqual(caps.map((m: any) => m.orden), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    caps.map((m: any) => m.paso_ruta),
    ['ENTRADA', 'DEFINO', 'PREGUNTO', 'ORGANIZO', 'VERIFICO', 'APLICO', 'DECIDO', 'INTEGRO'],
    'la ruta se recorre en el orden del plan, no en cualquiera',
  );

  // El orden del documento NO es el alfabético: cargar los .docx por nombre de archivo habría
  // funcionado por casualidad aquí, pero los títulos no siguen ese orden.
  const titulos = caps.map((m: any) => m.titulo);
  const alfabetico = [...titulos].sort((a, b) => a.localeCompare(b, 'es'));
  assert.notDeepEqual(titulos, alfabetico, 'el orden curricular no coincide con el alfabético');
  assert.match(titulos[0], /IA como apoyo/, 'abre la de entrada');
  assert.match(titulos[7], /Actividad de cierre/, 'cierra la actividad final');
});

test('la duración total cae en los 40 a 60 minutos que el plan declara', () => {
  const caps = CURRICULO.microcapsulas;
  const total = caps.reduce((a: number, m: any) => a + m.duracion_min, 0);
  assert.ok(total >= 40 && total <= 60, `total ${total} min fuera del rango del plan`);
  for (const m of caps.slice(0, 7)) {
    assert.ok(m.duracion_min >= 5 && m.duracion_min <= 7, `cápsula ${m.orden}: ${m.duracion_min} min`);
  }
  // La 8 es la actividad de cierre y su propio documento pide «7 a 10 minutos».
  assert.ok(caps[7].duracion_min >= 7 && caps[7].duracion_min <= 10);
});

test('ninguna microcápsula avanza sin su momento "Lo intento"', () => {
  // El plan lo exige en todas: «Cada microcápsula incorpora al menos una acción breve del
  // participante». Si una quedara sin interacción, el avance la saltaría en silencio.
  for (const m of CURRICULO.microcapsulas) {
    assert.ok(m.interaccion, `cápsula ${m.orden} sin interacción`);
    assert.ok(m.interaccion.items.length >= 1, `cápsula ${m.orden} sin ítems`);
    assert.ok(m.interaccion.minimo_requerido >= 1, `cápsula ${m.orden} sin mínimo`);
    assert.ok(String(m.guion_apertura ?? '').length > 40, `cápsula ${m.orden} sin guion de apertura`);
    assert.ok(String(m.guion_cierre ?? '').length > 40, `cápsula ${m.orden} sin guion de cierre`);
  }
});

// ── 2. El traspaso al cerrar la práctica ────────────────────────────────────

// Doble mínimo del almacén: una actividad de un ítem, la de la cápsula 3 (PREGUNTO).
const PREGUNTA = {
  id: 'q1', orden: 1, tipo: 'seleccion_multiple', enunciado: '¿Cuál de estas solicitudes es más útil?',
  explicacion: 'La solicitud más útil explicita la necesidad, el contexto y el resultado esperado.',
  sinRespuestaCorrecta: false, itemTexto: null,
  opciones: [
    { id: 'o1', orden: 1, texto: 'Cursos', esCorrecta: false },
    { id: 'o2', orden: 2, texto: 'Cursos vespertinos', esCorrecta: true },
  ],
};

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/evaluaciones.ts', {
  namedExports: {
    quizDeLeccion: async () => ({ id: 'z3', titulo: 'Lo intento' }),
    quizzesPendientes: async () => 0,
    quizParaIniciar: async () => ({ quizId: 'z3', titulo: 'Lo intento', enrollmentId: 'e1' }),
    iniciarAttempt: async () => ({
      attemptId: 'a1', quizId: 'z3', titulo: 'Lo intento', intentoN: 1, total: 1,
      primera: PREGUNTA,
      interaccion: {
        tipo: 'seleccion_unica', consigna: 'Elige la solicitud más útil.',
        retroalimentacion: PREGUNTA.explicacion, minimoRequerido: 1,
      },
    }),
    registrarRespuesta: async (_a: string, _q: string, pregunta: any, optionId: string) => {
      const elegida = pregunta.opciones.find((o: any) => o.id === optionId);
      if (!elegida) return null;
      return {
        esCorrecta: elegida.esCorrecta, correctaTexto: 'Cursos vespertinos',
        explicacion: pregunta.explicacion, sinRespuestaCorrecta: false,
        elegidaTexto: elegida.texto, correctas: elegida.esCorrecta ? 1 : 0, total: 1,
        siguiente: null, finalizado: true,
      };
    },
  },
});

const { manejarEvaluacion, marcarQuizPendiente, iniciarQuizPendiente } = await import('../src/flows/evaluacion');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async () => OK,
    enviarLista: async () => OK,
    enviarDocumento: async () => OK,
    marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, textos };
}

let n = 0, nWa = 0;
let DE = '+56900110001';
const nuevo = () => (DE = `+5690011${String(++nWa).padStart(4, '0')}`);
const btn = (id: string, titulo: string): InboundMessage =>
  ({ waMessageId: 'w' + ++n, from: DE, timestamp: new Date(), type: 'interactive', interactiveReplyId: id, interactiveReplyTitle: titulo });
const PERSONA = { id: 'p1', nombre: 'Rodrigo' } as any;

test('caso 7 — cerrada una microcápsula intermedia, el traspaso apunta a la siguiente', async () => {
  nuevo();
  const { p, textos } = fakeProvider();
  await marcarQuizPendiente(DE, false); // no es la última
  await iniciarQuizPendiente(DE, PERSONA, p);
  await manejarEvaluacion(btn('resp:o2', 'Cursos vespertinos'), PERSONA, p);

  const cierre = textos.at(-1)!;
  assert.match(cierre, /próxima microcápsula/i, 'invita a la siguiente');
  assert.match(cierre, /\*continuar\*/, 'y le dice con qué palabra pedirla');
  assert.doesNotMatch(cierre, /certificado/i,
    'ofrecer el certificado a mitad de curso fabricaría un logro que no existe');
  assert.match(cierre, /explicita la necesidad/, 'el criterio del documento va en ese mismo mensaje');
});

test('caso 7 — cerrada la última, apunta al certificado y no a una microcápsula inexistente', async () => {
  nuevo();
  const { p, textos } = fakeProvider();
  await marcarQuizPendiente(DE, true); // era la última
  await iniciarQuizPendiente(DE, PERSONA, p);
  await manejarEvaluacion(btn('resp:o2', 'Cursos vespertinos'), PERSONA, p);

  const cierre = textos.at(-1)!;
  assert.match(cierre, /terminaste todas las microcápsulas/i);
  assert.match(cierre, /\*certificado\*/);
  assert.doesNotMatch(cierre, /próxima microcápsula/i);
});

test('el traspaso no depende del modelo: la marca de fin de curso viaja en el estado', async () => {
  // Quien decide si corresponde certificado o siguiente microcápsula es completarLeccionActual,
  // en la misma transacción que registró el avance. El LLM no participa de esa decisión.
  nuevo();
  const { p, textos } = fakeProvider();
  await marcarQuizPendiente(DE, false);
  await iniciarQuizPendiente(DE, PERSONA, p);
  // Respuesta equivocada: el traspaso es el mismo. Certificar o no NO depende de acertar,
  // porque la certificación es por finalización y sin evaluación formal.
  await manejarEvaluacion(btn('resp:o1', 'Cursos'), PERSONA, p); // primer error → revisión
  await manejarEvaluacion(btn('resp:o1', 'Cursos'), PERSONA, p); // insiste → se cierra igual
  const cierre = textos.at(-1)!;
  assert.match(cierre, /próxima microcápsula/i, 'el avance no se bloquea por haber fallado');
  assert.doesNotMatch(cierre.toLowerCase(), /nota|puntaje|aprob/, 'y no aparece ninguna calificación');
});
