import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Flujo determinista de evaluación (Fase 7): inicio por oferta/comando, preguntas interactivas
// (lista para SM, botones para V/F), mapeo exacto de respuestas, retroalimentación docente,
// resumen final y pausa. Stores SIMULADOS; sin LLM en todo el flujo.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const OP = (id: string, texto: string, ok: boolean) => ({ id, orden: 0, texto, esCorrecta: ok });
const P1 = {
  id: 'q1', orden: 1, tipo: 'seleccion_multiple' as const,
  enunciado: '¿Qué describe mejor a la IA?',
  explicacion: 'La Microcápsula 1 explica: aprende de datos y genera respuestas.',
  opciones: [OP('o1a', 'Un robot físico', false), OP('o1b', 'Sistemas que aprenden de datos', true), OP('o1c', 'Solo repite texto', false), OP('o1d', 'Tecnología de laboratorio', false)],
};
const P2 = {
  id: 'q2', orden: 2, tipo: 'verdadero_falso' as const,
  enunciado: 'La IA solo existe en laboratorios.',
  explicacion: 'Falso: la Microcápsula 1 muestra que la IA ya es parte de la vida cotidiana.',
  opciones: [OP('o2v', 'Verdadero', false), OP('o2f', 'Falso', true)],
};

type Att = { respuestas: { qid: string; ok: boolean; tiempoMs: number | null }[]; intentoN: number };
const attempts = new Map<string, Att>();
let proximoIntento = 1;

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/evaluaciones.ts', {
  namedExports: {
    quizDeLeccion: async () => ({ id: 'quiz1', titulo: 'Mini-quiz — Microcápsula 1' }),
    quizParaIniciar: async () => ({ quizId: 'quiz1', titulo: 'Mini-quiz — Microcápsula 1', enrollmentId: 'e1' }),
    iniciarAttempt: async () => {
      const attemptId = 'a' + proximoIntento;
      attempts.set(attemptId, { respuestas: [], intentoN: proximoIntento });
      return { attemptId, quizId: 'quiz1', titulo: 'Mini-quiz — Microcápsula 1', intentoN: proximoIntento++, total: 2, primera: P1 };
    },
    registrarRespuesta: async (attemptId: string, _quizId: string, pregunta: any, optionId: string, tiempoMs: number | null) => {
      const att = attempts.get(attemptId)!;
      const elegida = pregunta.opciones.find((o: any) => o.id === optionId);
      att.respuestas.push({ qid: pregunta.id, ok: elegida.esCorrecta, tiempoMs });
      const finalizado = att.respuestas.length >= 2;
      return {
        esCorrecta: elegida.esCorrecta,
        correctaTexto: pregunta.opciones.find((o: any) => o.esCorrecta).texto,
        explicacion: pregunta.explicacion,
        correctas: att.respuestas.filter((r) => r.ok).length,
        total: 2,
        siguiente: finalizado ? null : P2,
        finalizado,
      };
    },
  },
});

const { manejarEvaluacion, marcarOfertaQuiz, mapearRespuestaAOpcion } = await import('../src/flows/evaluacion');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const botones: { cuerpo: string; ids: string[] }[] = [];
  const listas: { cuerpo: string; ids: string[]; titulos: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async (_t, cuerpo, bs) => (botones.push({ cuerpo, ids: bs.map((b) => b.id) }), OK),
    enviarLista: async (_t, cuerpo, _btn, ops) => (listas.push({ cuerpo, ids: ops.map((o) => o.id), titulos: ops.map((o) => o.titulo) }), OK),
    enviarDocumento: async () => OK,
    marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, textos, botones, listas };
}

let n = 100;
const texto = (from: string, t: string): InboundMessage => ({ waMessageId: 'wamid.e' + ++n, from, timestamp: new Date(), type: 'text', text: t });
const btn = (from: string, id: string, titulo: string): InboundMessage => ({ waMessageId: 'wamid.e' + ++n, from, timestamp: new Date(), type: 'interactive', interactiveReplyId: id, interactiveReplyTitle: titulo });
const PERSONA = { id: 'p1', nombre: 'Rodrigo', apellido: 'Palma', email: null, emailVerificado: false };

test('mapearRespuestaAOpcion: botón, letras y V/F; inválidos → null', () => {
  assert.equal(mapearRespuestaAOpcion(btn('+1', 'resp:o1b', 'B'), P1 as any), 'o1b');
  assert.equal(mapearRespuestaAOpcion(texto('+1', 'b'), P1 as any), 'o1b');
  assert.equal(mapearRespuestaAOpcion(texto('+1', 'D.'), P1 as any), 'o1d');
  assert.equal(mapearRespuestaAOpcion(texto('+1', 'no sé'), P1 as any), null);
  assert.equal(mapearRespuestaAOpcion(texto('+1', 'falso'), P2 as any), 'o2f');
  assert.equal(mapearRespuestaAOpcion(texto('+1', 'V'), P2 as any), 'o2v');
});

test('ciclo completo: comando quiz → SM por lista → correcta → V/F por botones → incorrecta → resumen', async () => {
  const { p, textos, botones, listas } = fakeProvider();
  const from = '+56900040001';

  // Inicio por comando
  let r = await manejarEvaluacion(texto(from, 'quiero hacer el quiz'), PERSONA as any, p);
  assert.equal(r.handled, true);
  assert.match(textos[0], /Mini-quiz/);
  assert.match(textos[0], /no hay nota/i);
  assert.equal(listas.length, 1, 'la SM va como lista');
  assert.deepEqual(listas[0].titulos, ['A', 'B', 'C', 'D']);
  assert.ok(listas[0].ids.every((id) => id.startsWith('resp:')));

  // Respuesta correcta por botón de lista
  r = await manejarEvaluacion(btn(from, 'resp:o1b', 'B'), PERSONA as any, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /✅/);
  assert.match(textos.at(-1)!, /Microcápsula 1/);
  assert.equal(botones.length, 1, 'la V/F va como botones');
  assert.deepEqual(botones[0].ids, ['resp:o2v', 'resp:o2f']);

  // Respuesta incorrecta por texto → cuál era la correcta + explicación + resumen final
  r = await manejarEvaluacion(texto(from, 'verdadero'), PERSONA as any, p);
  assert.equal(r.handled, true);
  const feedback = textos.at(-2)!;
  assert.match(feedback, /correcta era: \*Falso\*/);
  assert.match(feedback, /Microcápsula 1/);
  const resumen = textos.at(-1)!;
  assert.match(resumen, /1\/2/);
  assert.match(resumen, /continuar/i);

  // Registro §9: respuestas con tiempo medido
  const att = attempts.get('a1')!;
  assert.equal(att.respuestas.length, 2);
  assert.ok(att.respuestas.every((x) => typeof x.tiempoMs === 'number' && x.tiempoMs! >= 0));

  // Estado limpio: el siguiente mensaje pasa al tutor
  r = await manejarEvaluacion(texto(from, 'hola de nuevo'), PERSONA as any, p);
  assert.equal(r.handled, false);
});

test('reintento, re-guía ante texto no reconocido y salida con pausa', async () => {
  const { p, textos, listas } = fakeProvider();
  const from = '+56900040002';

  await manejarEvaluacion(texto(from, 'quiz'), PERSONA as any, p); // intento 2 global
  assert.match(textos[0], /intento 2/);

  // Texto no mapeable durante el quiz → re-guía y reenvía la pregunta (handled)
  let r = await manejarEvaluacion(texto(from, '¿me explicas la pregunta?'), PERSONA as any, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /botones|letra/i);
  assert.equal(listas.length, 2, 'reenvió la pregunta');

  // Salir → pausa y el siguiente mensaje va al tutor
  r = await manejarEvaluacion(texto(from, 'salir'), PERSONA as any, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /pausamos/i);
  r = await manejarEvaluacion(texto(from, 'una duda del curso'), PERSONA as any, p);
  assert.equal(r.handled, false);
});

test('oferta tras completar lección: sí inicia, no la descarta', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900040003';

  await marcarOfertaQuiz(from);
  let r = await manejarEvaluacion(texto(from, 'no gracias'), PERSONA as any, p);
  assert.equal(r.handled, false, 'el rechazo pasa al tutor (que sigue la conversación)');
  // La oferta quedó descartada: un "sí" posterior ya no inicia nada
  r = await manejarEvaluacion(texto(from, 'sí'), PERSONA as any, p);
  assert.equal(r.handled, false);

  await marcarOfertaQuiz(from);
  r = await manejarEvaluacion(texto(from, 'sí, dale'), PERSONA as any, p);
  assert.equal(r.handled, true, 'la aceptación de la oferta inicia el quiz');
  assert.match(textos.at(-2) ?? textos.at(-1)!, /Mini-quiz/);
});

test('sin persona o sin BD: el flujo no intercepta', async () => {
  const { p } = fakeProvider();
  const r = await manejarEvaluacion(texto('+56900040004', 'quiz'), null, p);
  assert.equal(r.handled, false);
});
