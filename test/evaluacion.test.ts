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
  explicacion: 'La Microcápsula 1 explica: aprende de datos y genera respuestas.', sinRespuestaCorrecta: false, itemTexto: null,
  opciones: [OP('o1a', 'Un robot físico', false), OP('o1b', 'Sistemas que aprenden de datos', true), OP('o1c', 'Solo repite texto', false), OP('o1d', 'Tecnología de laboratorio', false)],
};
const P2 = {
  id: 'q2', orden: 2, tipo: 'verdadero_falso' as const,
  enunciado: 'La IA solo existe en laboratorios.',
  explicacion: 'Falso: la Microcápsula 1 muestra que la IA ya es parte de la vida cotidiana.', sinRespuestaCorrecta: false, itemTexto: null,
  opciones: [OP('o2v', 'Verdadero', false), OP('o2f', 'Falso', true)],
};

type Att = { respuestas: { qid: string; ok: boolean; tiempoMs: number | null }[]; intentoN: number };
const attempts = new Map<string, Att>();
let proximoIntento = 1;
/** Estado simulado para el caso "pidió práctica y no hay ninguna". */
let pendientesSim = 0;
let hayQuizSim = true;
let estadoSim: any = { inscrito: true, completadas: 1, totalLecciones: 8 };

mock.module('../src/store/cursos.ts', {
  namedExports: {
    estadoAcademico: async () => estadoSim,
    cursoActivo: async () => null,
    inscribir: async () => null,
    entregarLeccionActual: async () => null,
    completarLeccionActual: async () => null,
    contextoAcademico: async () => '',
    avancePrevioArchivado: async () => null,
    frasePrevio: () => '',
  },
});
mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/evaluaciones.ts', {
  namedExports: {
    quizDeLeccion: async () => ({ id: 'quiz1', titulo: 'Mini-quiz — Microcápsula 1' }),
    quizzesPendientes: async () => pendientesSim,
    quizParaIniciar: async () => (hayQuizSim ? { quizId: 'quiz1', titulo: 'Mini-quiz — Microcápsula 1', enrollmentId: 'e1' } : null),
    iniciarAttempt: async () => {
      const attemptId = 'a' + proximoIntento;
      attempts.set(attemptId, { respuestas: [], intentoN: proximoIntento });
      return {
        attemptId, quizId: 'quiz1', titulo: 'Lo intento — Microcápsula 1',
        intentoN: proximoIntento++, total: 2, primera: P1,
        interaccion: {
          tipo: 'seleccion_unica',
          consigna: 'Responde las dos preguntas de práctica.',
          retroalimentacion: 'El criterio: la IA apoya, la decisión sigue siendo de la persona.',
          minimoRequerido: 2,
        },
      };
    },
    registrarRespuesta: async (attemptId: string, _quizId: string, pregunta: any, optionId: string, tiempoMs: number | null) => {
      const att = attempts.get(attemptId)!;
      const elegida = pregunta.opciones.find((o: any) => o.id === optionId);
      // Fiel al almacén (ON CONFLICT DO NOTHING): revisar un ítem no crea un segundo registro.
      if (!att.respuestas.some((x) => x.qid === pregunta.id)) att.respuestas.push({ qid: pregunta.id, ok: elegida.esCorrecta, tiempoMs });
      const finalizado = att.respuestas.length >= 2;
      return {
        esCorrecta: elegida.esCorrecta,
        correctaTexto: pregunta.opciones.find((o: any) => o.esCorrecta).texto,
        explicacion: pregunta.explicacion,
        sinRespuestaCorrecta: false,
        elegidaTexto: elegida.texto,
        correctas: att.respuestas.filter((r) => r.ok).length,
        total: 2,
        siguiente: finalizado ? null : P2,
        finalizado,
      };
    },
  },
});

const { manejarEvaluacion, marcarQuizPendiente, iniciarQuizPendiente, tomarQuizPendiente, mapearRespuestaAOpcion } = await import('../src/flows/evaluacion');
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

test('ciclo completo: "Lo intento" abre con la consigna, acusa cada ítem y cierra con el criterio', async () => {
  const { p, textos, botones, listas } = fakeProvider();
  const from = '+56900040001';

  // Inicio por comando
  let r = await manejarEvaluacion(texto(from, 'quiero hacer el quiz'), PERSONA as any, p);
  assert.equal(r.handled, true);
  // El plan llama "Lo intento" a este momento, y la CONSIGNA del documento abre la actividad:
  // en una clasificación es lo único que explica qué se está pidiendo.
  assert.match(textos[0], /Lo intento/);
  assert.match(textos[0], /no hay nota/i, 'la certificación es por finalización, sin evaluación formal');
  assert.match(textos[0], /Responde las dos preguntas de práctica/, 'la consigna del documento');
  assert.equal(listas.length, 1, 'la SM va como lista');
  assert.deepEqual(listas[0].titulos, ['A', 'B', 'C', 'D']);
  assert.ok(listas[0].ids.every((id) => id.startsWith('resp:')));

  // Respuesta correcta por botón de lista
  r = await manejarEvaluacion(btn(from, 'resp:o1b', 'B'), PERSONA as any, p);
  assert.equal(r.handled, true);
  // Acuse BREVE por ítem: el criterio completo va una sola vez al cerrar, no repetido en cada uno.
  assert.match(textos.at(-1)!, /✅/);
  assert.doesNotMatch(textos.at(-1)!, /Microcápsula 1/, 'el criterio no se repite ítem por ítem');
  assert.equal(botones.length, 1, 'la V/F va como botones');
  assert.deepEqual(botones[0].ids, ['resp:o2v', 'resp:o2f']);

  // Respuesta incorrecta por texto → primero la revisión que el material exige («Permitir
  // "Revisar de nuevo" sin penalización»), sin revelar todavía la alternativa correcta.
  r = await manejarEvaluacion(texto(from, 'verdadero'), PERSONA as any, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /Revisémoslo/);
  assert.doesNotMatch(textos.join(' '), /correspondía/, 'todavía no: quedaría nada que revisar');
  assert.equal(botones.length, 2, 'el MISMO ítem vuelve con sus botones');

  // Insiste en la misma → ahí sí cuál correspondía, el criterio y el traspaso.
  r = await manejarEvaluacion(texto(from, 'verdadero'), PERSONA as any, p);
  assert.equal(r.handled, true);
  const feedback = textos.at(-2)!;
  assert.match(feedback, /correspondía: \*Falso\*/, 'dice cuál era, sin sermón');
  const cierre = textos.at(-1)!;
  // El criterio del documento, completo y al final. Y SIN nota: mostrar "1/2" inventaría una
  // exigencia que el plan no establece — la certificación es por finalización.
  assert.match(cierre, /la decisión sigue siendo de la persona/, 'el criterio del documento');
  assert.doesNotMatch(cierre, /1\/2/, 'no se muestra puntaje');
  assert.match(cierre, /continuar/i);

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

// ── Quiz AUTOMÁTICO ─────────────────────────────────────────────────────────────────────────────
//
// El mini-quiz dejó de ofrecerse: se envía siempre al completar una microcápsula. El cambio nació
// de la prueba real del curso, donde ofrecerlo significó que 7 de 9 microcápsulas quedaran sin
// evaluar — decir "sigamos" es más fácil que decir "sí". La práctica ahora es el camino por
// omisión, y saltarla exige escribir *salir*.

test('el quiz se envía solo al completar la microcápsula, sin preguntar nada', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900040003';

  await marcarQuizPendiente(from, false);
  const arrancado = await iniciarQuizPendiente(from, PERSONA as any, p);
  assert.equal(arrancado, true, 'debe arrancar sin que el estudiante lo pida');
  assert.match(textos.join(' '), /Mini-quiz|pregunta/i);
});

test('sin quiz pendiente no se envía nada', async () => {
  const { p, textos } = fakeProvider();
  const arrancado = await iniciarQuizPendiente('+56900040013', PERSONA as any, p);
  assert.equal(arrancado, false);
  assert.equal(textos.length, 0);
});

test('el marcador de pendiente se consume una sola vez', async () => {
  // Si no se consumiera, un reintento del webhook de Meta mandaría el quiz dos veces.
  const { p } = fakeProvider();
  const from = '+56900040004';
  await marcarQuizPendiente(from, false);
  assert.equal(await tomarQuizPendiente(from) !== null, true);
  assert.equal(await tomarQuizPendiente(from), null, 'la segunda lectura no debe encontrar nada');
});

test('un "sí" ya no arranca ningún quiz: no hay oferta que aceptar', async () => {
  const { p } = fakeProvider();
  const from = '+56900040005';
  for (const t of ['sí', 'sí, dale', 'ok', 'sí, creo que quedó claro lo de los sesgos']) {
    const r = await manejarEvaluacion(texto(from, t), PERSONA as any, p);
    assert.equal(r.handled, false, `"${t}" debe seguir al tutor`);
  }
});

test('"quiz" sigue sirviendo para repetir uno por voluntad propia', async () => {
  const { p, textos } = fakeProvider();
  const r = await manejarEvaluacion(texto('+56900040006', 'quiz'), PERSONA as any, p);
  assert.equal(r.handled, true);
  assert.match(textos.join(' '), /Mini-quiz|pregunta/i);
});

test('el estudiante puede saltárselo con *salir*', async () => {
  const { p, textos } = fakeProvider();
  const from = '+56900040007';
  await marcarQuizPendiente(from, false);
  await iniciarQuizPendiente(from, PERSONA as any, p);
  const r = await manejarEvaluacion(texto(from, 'salir'), PERSONA as any, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /pausamos/i);
});


test('sin persona o sin BD: el flujo no intercepta', async () => {
  const { p } = fakeProvider();
  const r = await manejarEvaluacion(texto('+56900040004', 'quiz'), null, p);
  assert.equal(r.handled, false);
});

// ── Pedir práctica cuando no hay ninguna ───────────────────────────────────
// El caso del piloto: un estudiante registrado y SIN inscripción escribió "quiz". El flujo
// devolvía handled:false, el mensaje llegaba al tutor, y el tutor —que por prompt sabe que "el
// sistema envía la práctica"— le anunció una que nunca llegó.

test('sin inscripción, explica por qué no hay práctica en vez de dejar que el modelo prometa una', async () => {
  hayQuizSim = false;
  pendientesSim = 0;
  estadoSim = { inscrito: false };
  const { p, textos } = fakeProvider();
  const r = await manejarEvaluacion(texto('+56900050001', 'quiz'), PERSONA as any, p);

  assert.equal(r.handled, true, 'el mensaje NO debe llegar al tutor: prometería una práctica');
  assert.equal(textos.length, 1);
  assert.match(textos[0], /no est[áa]s inscrito/i);
  assert.match(textos[0], /\*empezar\*/, 'y le dice qué escribir');
});

test('inscrito pero sin microcápsulas completadas: dice que la práctica llega al terminar una', async () => {
  hayQuizSim = false;
  pendientesSim = 0;
  estadoSim = { inscrito: true, completadas: 0, totalLecciones: 8 };
  const { p, textos } = fakeProvider();
  await manejarEvaluacion(texto('+56900050002', 'quiero el quiz'), PERSONA as any, p);
  assert.match(textos[0], /A[úu]n no terminas la primera/i);
  assert.match(textos[0], /\*continuar\*/);
});

test('todo respondido: lo dice, sin inventar una práctica', async () => {
  hayQuizSim = false;
  pendientesSim = 0;
  estadoSim = { inscrito: true, completadas: 3, totalLecciones: 8 };
  const { p, textos } = fakeProvider();
  await manejarEvaluacion(texto('+56900050003', 'quiz'), PERSONA as any, p);
  assert.match(textos[0], /no tienes pr[áa]ctica pendiente/i);
});

test('si hay práctica pendiente y no se pudo abrir, lo llama falla técnica y no "no tienes"', async () => {
  // Decirle "no tienes práctica" a quien sí la tiene sería mentirle sobre su propio avance.
  hayQuizSim = false;
  pendientesSim = 2;
  estadoSim = { inscrito: true, completadas: 2, totalLecciones: 8 };
  const { p, textos } = fakeProvider();
  await manejarEvaluacion(texto('+56900050004', 'quiz'), PERSONA as any, p);
  assert.match(textos[0], /problema t[ée]cnico/i);
  assert.doesNotMatch(textos[0], /no tienes pr[áa]ctica/i);
  hayQuizSim = true;
  pendientesSim = 0;
});

test('la re-guía no promete botones cuando la actividad llegó como lista', async () => {
  // Decirle "responde con los botones" a quien tiene una lista en pantalla lo manda a buscar algo
  // que no está ahí. P1 tiene cuatro opciones largas: va como lista.
  hayQuizSim = true;
  pendientesSim = 0;
  const { p, textos } = fakeProvider();
  const from = '+56900060001';
  await manejarEvaluacion(texto(from, 'quiz'), PERSONA as any, p);
  await manejarEvaluacion(texto(from, 'no sé, explícame'), PERSONA as any, p);
  const reguia = textos.find((t) => /Estamos/.test(t))!;
  assert.match(reguia, /tocando \*Responder\*/);
  assert.doesNotMatch(reguia, /con los botones/);
  assert.match(reguia, /pregunta 1 de 2/, 'y sí dice dónde va, porque son dos');
});
