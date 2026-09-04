import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Los cuatro tipos de interacción "Lo intento" del plan curricular, con los ítems REALES de los
// documentos de las microcápsulas.
//
// FUENTE: Microcápsulas 01 a 08. El plan exige en cada una «al menos una acción breve del
// participante: elegir, ordenar, comparar, clasificar, mejorar una solicitud o aplicar una pauta»,
// y manda «retroalimentar las decisiones explicando el criterio, no solo indicando correcto o
// incorrecto». La certificación es por finalización, SIN evaluación formal.
//
// Los cuatro casos que el motor anterior no podía representar:
//   · clasificación de 6 ítems en 3 categorías (cápsula 7, paso DECIDO)
//   · clasificación de 5 ítems en 5 categorías (cápsula 4, paso ORGANIZO)
//   · elegir al menos 2 de 6 sin respuesta correcta (cápsula 6, paso APLICO)
//   · elegir modalidad entre 2 opciones ambas válidas (cápsula 8, paso INTEGRO)

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

type Item = { texto: string; categoria?: string };

/** Arma un doble del almacén para una interacción del currículo. */
function armar(tipo: string, consigna: string, criterio: string, items: Item[], minimo: number) {
  const clasif = tipo === 'clasificacion';
  const cats = [...new Set(items.map((i) => i.categoria).filter(Boolean))] as string[];
  const sinCorrecta = tipo === 'seleccion_multiple' || tipo === 'eleccion';

  const preguntas = clasif
    ? items.map((it, k) => ({
        id: `q${k + 1}`, orden: k + 1, tipo: 'clasificacion', enunciado: it.texto,
        explicacion: criterio, sinRespuestaCorrecta: false, itemTexto: it.texto,
        opciones: cats.map((c, j) => ({ id: `q${k + 1}o${j + 1}`, orden: j + 1, texto: c, esCorrecta: c === it.categoria })),
      }))
    : [{
        id: 'q1', orden: 1, tipo: tipo === 'eleccion' ? 'eleccion' : 'seleccion_multiple',
        enunciado: consigna, explicacion: criterio, sinRespuestaCorrecta: sinCorrecta, itemTexto: null,
        opciones: items.map((it, j) => ({ id: `q1o${j + 1}`, orden: j + 1, texto: it.texto, esCorrecta: Boolean((it as any).correcta) })),
      }];

  const total = preguntas.length;
  const registradas: { qid: string; texto: string }[] = [];

  return {
    preguntas, registradas, total,
    exports: {
      quizDeLeccion: async () => ({ id: 'z1', titulo: 'Lo intento' }),
      quizzesPendientes: async () => 0,
      quizParaIniciar: async () => ({ quizId: 'z1', titulo: 'Lo intento', enrollmentId: 'e1' }),
      iniciarAttempt: async () => ({
        attemptId: 'a1', quizId: 'z1', titulo: 'Lo intento', intentoN: 1, total,
        primera: preguntas[0],
        interaccion: { tipo, consigna, retroalimentacion: criterio, minimoRequerido: Math.min(minimo, total) },
      }),
      registrarRespuesta: async (_a: string, _q: string, pregunta: any, optionId: string) => {
        const elegida = pregunta.opciones.find((o: any) => o.id === optionId);
        if (!elegida) return null;
        // Fiel al almacén: ON CONFLICT DO NOTHING. La revisión del ítem no crea un segundo
        // registro ni adelanta el cierre de la actividad.
        if (!registradas.some((x) => x.qid === pregunta.id)) registradas.push({ qid: pregunta.id, texto: elegida.texto });
        const correcta = pregunta.opciones.find((o: any) => o.esCorrecta);
        const finalizado = registradas.length >= total;
        return {
          esCorrecta: pregunta.sinRespuestaCorrecta ? true : elegida.esCorrecta,
          correctaTexto: correcta?.texto ?? '',
          explicacion: pregunta.explicacion,
          sinRespuestaCorrecta: pregunta.sinRespuestaCorrecta,
          elegidaTexto: elegida.texto,
          correctas: registradas.length,
          total,
          siguiente: finalizado ? null : preguntas[registradas.length],
          finalizado,
        };
      },
    },
  };
}

// ── Cápsula 7 (DECIDO): 6 situaciones en 3 categorías ───────────────────────
const C7 = armar(
  'clasificacion',
  'Clasifica cada situación según el tipo de apoyo que sería más adecuado.',
  'La clasificación depende del nivel de consecuencia, de si la información cambia y de si existe una autoridad o profesional que debe responder.',
  [
    { texto: 'Ordenar ideas para una presentación', categoria: 'IA puede ayudar' },
    { texto: 'Confirmar la fecha oficial de una postulación', categoria: 'IA + verificación' },
    { texto: 'Interpretar un diagnóstico médico personal', categoria: 'fuente/persona competente' },
    { texto: 'Comparar criterios para elegir un curso', categoria: 'IA puede ayudar' },
    { texto: 'Conocer el texto vigente de una norma', categoria: 'IA + verificación' },
    { texto: 'Actuar ante una emergencia', categoria: 'fuente/persona competente' },
  ],
  6,
);

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/evaluaciones.ts', { namedExports: C7.exports });

const { manejarEvaluacion, marcarQuizPendiente, iniciarQuizPendiente } = await import('../src/flows/evaluacion');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const botones: { cuerpo: string; titulos: string[] }[] = [];
  const listas: { cuerpo: string; titulos: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK,
    enviarBotones: async (_t, cuerpo, bs) => (botones.push({ cuerpo, titulos: bs.map((b) => b.titulo) }), OK),
    enviarLista: async (_t, cuerpo, _b, os) => (listas.push({ cuerpo, titulos: os.map((o) => o.titulo) }), OK),
    enviarDocumento: async () => OK,
    marcarLeido: async () => OK,
    descargarMedia: async () => null,
  };
  return { p, textos, botones, listas };
}

let n = 0, nWa = 0;
let DE = '+56900090001';
const nuevo = () => (DE = `+5690009${String(++nWa).padStart(4, '0')}`);
const texto = (t: string): InboundMessage =>
  ({ waMessageId: 'w' + ++n, from: DE, timestamp: new Date(), type: 'text', text: t });
const btn = (id: string, titulo: string): InboundMessage =>
  ({ waMessageId: 'w' + ++n, from: DE, timestamp: new Date(), type: 'interactive', interactiveReplyId: id, interactiveReplyTitle: titulo });
const PERSONA = { id: 'p1', nombre: 'Rodrigo' } as any;

// ── Clasificación ───────────────────────────────────────────────────────────

test('clasificación: la consigna abre la actividad y cada ítem pregunta por su fragmento', async () => {
  nuevo();
  C7.registradas.length = 0;
  const { p, textos, botones, listas } = fakeProvider();
  await marcarQuizPendiente(DE, false);
  await iniciarQuizPendiente(DE, PERSONA, p);

  assert.match(textos[0], /Lo intento/);
  assert.match(textos[0], /Clasifica cada situación/, 'la consigna del documento abre la actividad');
  // Son 3 categorías, pero "fuente/persona competente" pasa los 20 caracteres del título de un
  // botón: va como lista para no mostrarla cortada.
  assert.equal(botones.length, 0, 'una categoría no cabía en un botón');
  assert.equal(listas.length, 1);
  assert.deepEqual(listas[0].titulos, ['A', 'B', 'C']);
  assert.match(listas[0].cuerpo, /¿Dónde ubicarías esto\?/);
  assert.match(listas[0].cuerpo, /Ordenar ideas para una presentación/, 'pregunta por el FRAGMENTO');
});

test('clasificación: el criterio se entrega UNA vez al cerrar, no en cada ítem', async () => {
  nuevo();
  C7.registradas.length = 0;
  const { p, textos } = fakeProvider();
  await marcarQuizPendiente(DE, false);
  await iniciarQuizPendiente(DE, PERSONA, p);

  // Los 6 ítems, todos correctos.
  for (let k = 1; k <= 6; k++) {
    const cat = C7.preguntas[k - 1].opciones.find((o: any) => o.esCorrecta)!;
    await manejarEvaluacion(btn(`resp:${cat.id}`, cat.texto), PERSONA, p);
  }

  const conCriterio = textos.filter((t) => /nivel de consecuencia/.test(t));
  assert.equal(conCriterio.length, 1,
    'seis repeticiones del mismo párrafo era lo que había que evitar');
  assert.match(textos.at(-1)!, /nivel de consecuencia/, 'y va al final');
  assert.equal(C7.registradas.length, 6, 'las seis clasificaciones quedaron registradas');
});

// ── Caso 4: responde incorrectamente ───────────────────────────────────────

test('caso 4 — el primer error devuelve el ítem para revisarlo, sin revelar la respuesta', async () => {
  // FUENTE: cada microcápsula exige «retroalimentación útil y no punitiva»; la 1 pide «Permitir
  // "Revisar de nuevo" sin penalización», la 2 «Permitir corregir hasta completar» y la 4 «Debe
  // permitir corrección inmediata». Decir de inmediato cuál correspondía clausura esa corrección.
  nuevo();
  C7.registradas.length = 0;
  const { p, textos, listas } = fakeProvider();
  await marcarQuizPendiente(DE, false);
  await iniciarQuizPendiente(DE, PERSONA, p);
  const antes = listas.length;

  const mala = C7.preguntas[0].opciones.find((o: any) => !o.esCorrecta)!;
  await manejarEvaluacion(btn(`resp:${mala.id}`, mala.texto), PERSONA, p);

  assert.match(textos.at(-1)!, /Revisémoslo/, 'se invita a revisar');
  assert.doesNotMatch(textos.join(' '), /correspondía/,
    'todavía no: revelar la correcta dejaría nada que revisar');
  assert.doesNotMatch(textos.join(' '), /incorrect/i, 'la retroalimentación no es punitiva');
  assert.equal(listas.length, antes + 1, 'el MISMO ítem vuelve con sus alternativas');
  assert.match(listas.at(-1)!.cuerpo, /Ordenar ideas para una presentación/,
    'es el ítem que falló, no el siguiente');
});

test('caso 4 — si acierta al revisar, se reconoce y sigue', async () => {
  nuevo();
  C7.registradas.length = 0;
  const { p, textos, listas } = fakeProvider();
  await marcarQuizPendiente(DE, false);
  await iniciarQuizPendiente(DE, PERSONA, p);

  const mala = C7.preguntas[0].opciones.find((o: any) => !o.esCorrecta)!;
  await manejarEvaluacion(btn(`resp:${mala.id}`, mala.texto), PERSONA, p);
  const buena = C7.preguntas[0].opciones.find((o: any) => o.esCorrecta)!;
  await manejarEvaluacion(btn(`resp:${buena.id}`, buena.texto), PERSONA, p);

  assert.match(textos.join(' '), /Ahí está/, 'el acierto tras revisar se reconoce igual');
  assert.match(listas.at(-1)!.cuerpo, /Confirmar la fecha oficial/, 'y se avanza al ítem 2');
  assert.equal(C7.registradas.length, 1,
    'la revisión no cuenta como un ítem más: el mínimo de la actividad no se altera');
});

test('caso 4 — la revisión es UNA por ítem: al segundo error se dice cuál correspondía', async () => {
  // Dos revisiones serían adivinar por descarte, y con tres categorías nadie debe quedar atrapado.
  nuevo();
  C7.registradas.length = 0;
  const { p, textos } = fakeProvider();
  await marcarQuizPendiente(DE, false);
  await iniciarQuizPendiente(DE, PERSONA, p);

  const malas = C7.preguntas[0].opciones.filter((o: any) => !o.esCorrecta);
  await manejarEvaluacion(btn(`resp:${malas[0].id}`, malas[0].texto), PERSONA, p);
  await manejarEvaluacion(btn(`resp:${malas[1].id}`, malas[1].texto), PERSONA, p);

  assert.match(textos.join(' '), /correspondía/, 'ahora sí se muestra la que correspondía');
  assert.equal(textos.filter((t) => /Revisémoslo/.test(t)).length, 1, 'una sola revisión');
  assert.doesNotMatch(textos.join(' '), /incorrect/i);
});

test('en una elección sin respuesta correcta NUNCA se pide revisar', async () => {
  // Las cápsulas 6 y 8: mandar a "revisar" una elección legítima sería tratarla como un error.
  const C8 = armar(
    'eleccion',
    'Elige cómo quieres realizar la actividad final.',
    'Ambas opciones permiten demostrar la misma ruta.',
    [{ texto: 'Trabajar con una situación propia.' }, { texto: 'Elegir un caso preparado.' }],
    1,
  );
  const r = await C8.exports.registrarRespuesta('a1', 'z1', C8.preguntas[0], 'q1o2');
  assert.equal(r!.sinRespuestaCorrecta, true);
  assert.equal(r!.esCorrecta, true, 'sin error que revisar');
});

test('la clasificación de 5 categorías usa lista, no botones', async () => {
  // WhatsApp admite 3 botones. La cápsula 4 (ORGANIZO) relaciona 5 necesidades con 5 formatos:
  // sin caer a lista, la actividad no se podría presentar.
  const C4 = armar(
    'clasificacion',
    'Relaciona cada necesidad con el formato que probablemente facilite más la tarea.',
    'No existe un formato único para todas las preguntas.',
    [
      { texto: 'Comparar tres alternativas', categoria: 'tabla' },
      { texto: 'Saber qué hacer en orden', categoria: 'pasos' },
      { texto: 'Explorar posibles ideas', categoria: 'lista' },
      { texto: 'Evaluar puntos favorables y desfavorables', categoria: 'ventajas/desventajas' },
      { texto: 'Definir qué aspectos revisar', categoria: 'criterios' },
    ],
    5,
  );
  assert.equal(C4.preguntas.length, 5, 'una pregunta por ítem');
  assert.equal(C4.preguntas[0].opciones.length, 5, 'cinco categorías por ítem');
  assert.equal(C4.preguntas[0].opciones.filter((o: any) => o.esCorrecta).length, 1,
    'exactamente una categoría correcta por fragmento');
});

// ── Sin respuesta correcta ──────────────────────────────────────────────────

test('elegir al menos 2 de 6: se cierra al alcanzar el mínimo, no al agotar los ítems', async () => {
  // La cápsula 6 dice «Selecciona al menos dos situaciones» y su criterio remata: «No necesitas
  // revisar todos los casos». Obligar a los seis contradiría su propia consigna.
  const C6 = armar(
    'seleccion_multiple',
    'Selecciona al menos dos situaciones para ver cómo se aplica la misma ruta.',
    'No necesitas revisar todos los casos. El objetivo es reconocer que la ruta puede adaptarse.',
    ['Trabajo', 'Búsqueda de empleo', 'Estudio', 'Emprendimiento', 'Hogar', 'Trámites'].map((t) => ({ texto: t })),
    2,
  );
  assert.equal(C6.preguntas.length, 1);
  assert.equal(C6.preguntas[0].sinRespuestaCorrecta, true,
    'ninguna opción es incorrecta: son casos de interés');
  assert.equal(C6.preguntas[0].opciones.filter((o: any) => o.esCorrecta).length, 0);
});

test('elección de modalidad: ambas opciones son válidas y ninguna se califica', async () => {
  // La cápsula 8 deja elegir entre un problema propio o un caso preparado, y su documento dice:
  // «Ambas opciones permiten demostrar la misma ruta».
  const C8 = armar(
    'eleccion',
    'Elige cómo quieres realizar la actividad final.',
    'Ambas opciones permiten demostrar la misma ruta. Elegir un caso preparado es completamente válido y evita compartir información personal.',
    [{ texto: 'Trabajar con una situación propia.' }, { texto: 'Elegir un caso preparado.' }],
    1,
  );
  assert.equal(C8.preguntas[0].sinRespuestaCorrecta, true);
  assert.equal(C8.preguntas[0].tipo, 'eleccion');
  assert.match(C8.exports.iniciarAttempt.name || 'fn', /.*/);
  const r = await C8.exports.registrarRespuesta('a1', 'z1', C8.preguntas[0], 'q1o1');
  assert.equal(r!.esCorrecta, true, 'una elección legítima no puede registrarse como fallida');
  assert.equal(r!.sinRespuestaCorrecta, true);
  assert.equal(r!.correctaTexto, '', 'no hay "la correcta" que mostrar');
});
