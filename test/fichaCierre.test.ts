import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Producto de cierre del nivel: la ficha breve de resolución de problema.
//
// FUENTE: plan curricular — «Ficha breve de resolución de problema con apoyo de IA, que incluya:
// problema identificado, pregunta formulada, respuesta obtenida, verificación básica y decisión o
// acción posible»; «funciona como evidencia de aplicación, sin constituir una evaluación formal».
//
// Y del documento de la microcápsula 2: «Si la plataforma permite persistencia, la frase personal
// puede recuperarse en la cápsula 8».

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

type F = {
  id: string; enrollmentId: string; modalidad: string | null;
  problema: string | null; preguntaFormulada: string | null; respuestaObtenida: string | null;
  verificacion: string | null; decision: string | null; completadoEn: Date | null;
};
const vacia = (): F => ({
  id: 'f1', enrollmentId: 'e1', modalidad: null,
  problema: null, preguntaFormulada: null, respuestaObtenida: null,
  verificacion: null, decision: null, completadoEn: null,
});
let ficha: F = vacia();
let nota: string | null = null;
let completada = 0;

const MAPEO: Record<string, keyof F> = {
  problema: 'problema', pregunta_formulada: 'preguntaFormulada',
  respuesta_obtenida: 'respuestaObtenida', verificacion: 'verificacion', decision: 'decision',
};

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/cursos.ts', {
  namedExports: {
    completarLeccionActual: async () => (completada++, { completada: { id: 'l8', orden: 8, titulo: 'Actividad de cierre' }, minutosAcumulados: 55, cursoCompletado: true }),
  },
});
mock.module('../src/store/fichaCierre.ts', {
  namedExports: {
    CAMPOS_FICHA: [
      { campo: 'problema', paso: 'DEFINO' },
      { campo: 'pregunta_formulada', paso: 'PREGUNTO' },
      { campo: 'respuesta_obtenida', paso: 'ORGANIZO' },
      { campo: 'verificacion', paso: 'VERIFICO' },
      { campo: 'decision', paso: 'DECIDO' },
    ],
    abrirFicha: async (_p: string, modalidad?: string) => {
      if (modalidad && !ficha.modalidad) ficha.modalidad = modalidad;
      return ficha;
    },
    fichaDePersona: async () => ficha,
    guardarCampo: async (_id: string, campo: string, texto: string) => {
      (ficha as any)[MAPEO[campo]] = texto;
      return true;
    },
    cerrarSiCompleta: async () => {
      const lleno = ['problema', 'preguntaFormulada', 'respuestaObtenida', 'verificacion', 'decision']
        .every((k) => (ficha as any)[k]);
      if (lleno && !ficha.completadoEn) ficha.completadoEn = new Date();
      return ficha.completadoEn !== null;
    },
    notaDeMicrocapsula2: async () => nota,
    guardarNota: async () => true,
    siguienteCampo: (f: F) => {
      const orden = [
        ['problema', 'DEFINO'], ['pregunta_formulada', 'PREGUNTO'], ['respuesta_obtenida', 'ORGANIZO'],
        ['verificacion', 'VERIFICO'], ['decision', 'DECIDO'],
      ] as const;
      const p = orden.find(([c]) => !(f as any)[MAPEO[c]]);
      return p ? { campo: p[0], paso: p[1] } : null;
    },
  },
});

const { manejarFichaCierre, iniciarFicha } = await import('../src/flows/fichaCierre');
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
let DE = '+56900100001';
const nuevo = () => (DE = `+5690010${String(++nWa).padStart(4, '0')}`);
const texto = (t: string): InboundMessage =>
  ({ waMessageId: 'w' + ++n, from: DE, timestamp: new Date(), type: 'text', text: t });
const PERSONA = { id: 'p1', nombre: 'Rodrigo' } as any;
const reset = () => { ficha = vacia(); nota = null; completada = 0; nuevo(); };

const CINCO = [
  'Necesito encontrar un curso de computación cerca de mi casa que sea de tarde',
  'Quiero comparar cursos de computación básica en Providencia, en horario vespertino',
  'Me daría una tabla con nombre, horario, duración y costo de cada uno',
  'Los horarios y el costo, porque cambian; los revisaría en el sitio de cada institución',
  'Voy a llamar mañana a los dos que mejor calcen con mi horario',
];

// ── Caso 5: demuestra dominio y avanza ──────────────────────────────────────

test('caso 5 — la ficha recorre los cinco pasos de la ruta, en orden', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await iniciarFicha(DE, PERSONA, p, 'propia');

  assert.match(textos[0], /Actividad de cierre/);
  assert.match(textos[0], /cinco preguntas/i);
  assert.match(textos[0], /no hay respuestas correctas ni incorrectas/i,
    'el plan dice que es evidencia de aplicación, no evaluación formal');
  assert.match(textos[1], /1 de 5/);
  assert.match(textos[1], /DEFINO/, 'cada campo nombra su paso de la ruta');

  const pasos: string[] = [];
  for (const r of CINCO) {
    pasos.push(textos.at(-1)!);
    await manejarFichaCierre(texto(r), PERSONA, p);
  }
  assert.deepEqual(
    pasos.map((t) => (t.match(/\*(DEFINO|PREGUNTO|ORGANIZO|VERIFICO|DECIDO)\*/) ?? [])[1]),
    ['DEFINO', 'PREGUNTO', 'ORGANIZO', 'VERIFICO', 'DECIDO'],
    'los cinco campos SON los cinco pasos, en el orden del plan',
  );
  assert.equal(ficha.completadoEn !== null, true);
  assert.equal(completada, 1, 'la ficha completa la microcápsula 8');
  assert.match(textos.at(-1)!, /certificado/i, 'y con ella el curso: se ofrece el certificado');
});

test('la ficha guarda el texto de la persona tal cual, sin reescribirlo', async () => {
  reset();
  const { p } = fakeProvider();
  await iniciarFicha(DE, PERSONA, p, 'propia');
  await manejarFichaCierre(texto(CINCO[0]), PERSONA, p);
  assert.equal(ficha.problema, CINCO[0], 'es su evidencia, no la nuestra');
});

// ── Caso 3 aplicado a la ficha: abandona y vuelve ──────────────────────────

test('caso 3 — se retoma en el paso donde quedó', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await iniciarFicha(DE, PERSONA, p, 'propia');
  await manejarFichaCierre(texto(CINCO[0]), PERSONA, p);
  await manejarFichaCierre(texto(CINCO[1]), PERSONA, p);
  await manejarFichaCierre(texto('salir'), PERSONA, p);
  assert.match(textos.at(-1)!, /ORGANIZO/, 'dice en qué paso quedó');

  const seg = fakeProvider();
  await manejarFichaCierre(texto('ficha'), PERSONA, seg.p);
  const todo = seg.textos.join(' ');
  assert.match(todo, /3 de 5/, 'retoma en el tercero');
  assert.match(todo, /ORGANIZO/);
  assert.doesNotMatch(todo, /Actividad de cierre/, 'no repite la introducción');
});

// ── Continuidad con la microcápsula 2 ──────────────────────────────────────

test('si escribió su necesidad en la microcápsula 2, se le ofrece como punto de partida', async () => {
  // El documento de la cápsula 2 lo pide: «la frase personal puede recuperarse en la cápsula 8».
  reset();
  nota = 'Quiero cambiarme a un trabajo administrativo pero no sé qué me falta';
  const { p, textos } = fakeProvider();
  await iniciarFicha(DE, PERSONA, p, 'propia');
  assert.match(textos[0], /microcápsula 2/i);
  assert.match(textos[0], /Quiero cambiarme a un trabajo administrativo/);
  assert.match(textos[0], /puedes partir de ahí o cambiar de tema/i, 'sin obligarla a ese tema');
});

test('sin nota previa, la introducción no menciona nada que no exista', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await iniciarFicha(DE, PERSONA, p, 'caso_preparado');
  assert.doesNotMatch(textos[0], /microcápsula 2/i);
  assert.equal(ficha.modalidad, 'caso_preparado', 'la modalidad elegida queda registrada');
});

// ── Caso 6: intenta saltarse el requisito ──────────────────────────────────

test('caso 6 — una respuesta vacía o de un carácter no avanza el paso', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await iniciarFicha(DE, PERSONA, p, 'propia');
  for (const intento of ['ok', '.', 'si']) {
    await manejarFichaCierre(texto(intento), PERSONA, p);
    assert.match(textos.at(-1)!, /Cuéntame un poco más/);
  }
  assert.equal(ficha.problema, null, 'nada se guardó');
  assert.equal(completada, 0, 'y la microcápsula 8 sigue incompleta');
});

test('una ficha ya completa no se vuelve a pedir', async () => {
  reset();
  const { p, textos } = fakeProvider();
  ficha = { ...vacia(), problema: 'a', preguntaFormulada: 'b', respuestaObtenida: 'c', verificacion: 'd', decision: 'e', completadoEn: new Date() };
  const r = await manejarFichaCierre(texto('ficha'), PERSONA, p);
  assert.equal(r.handled, true);
  assert.match(textos.at(-1)!, /ya está completa/i);
});

test('un mensaje cualquiera no dispara la ficha', async () => {
  reset();
  const { p } = fakeProvider();
  const r = await manejarFichaCierre(texto('tengo una duda sobre la microcápsula 3'), PERSONA, p);
  assert.equal(r.handled, false, 'esa consulta le pertenece al tutor');
});
