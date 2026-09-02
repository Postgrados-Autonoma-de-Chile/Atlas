import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Práctica pendiente para quien ya completó el curso.
//
// El mini-quiz automático solo se dispara al completar una microcápsula. Quien terminó el curso —o
// lo recorrió cuando el quiz era opcional— acumula evaluaciones sin rendir que quedaban invisibles:
// solo las encontraba adivinando la palabra "quiz". Le pasó a las tres personas del piloto, una de
// ellas con 6 de 8 quizzes pendientes tras haber recibido su certificado.
//
// Las herramientas de progreso ahora informan cuántas quedan, y el prompt sabe ofrecerlas.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let pendientes = 0;
const CURSO_TERMINADO = {
  inscrito: true,
  curso: { id: 'c1', codigo: 'NIVEL-INICIAL-P1', nombre: 'IA en la vida cotidiana', duracionMin: 58 },
  enrollment: { id: 'e1', estado: 'completada', minutosAcumulados: 58 },
  totalLecciones: 9,
  completadas: 9,
  proxima: undefined,
};

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/personas.ts', {
  namedExports: { buscarPersonaPorWaId: async () => null },
});
mock.module('../src/store/cursos.ts', {
  namedExports: {
    cursoActivo: async () => CURSO_TERMINADO.curso,
    inscribir: async () => CURSO_TERMINADO,
    estadoAcademico: async () => CURSO_TERMINADO,
    // Curso terminado: no queda microcápsula por entregar ni por completar.
    entregarLeccionActual: async () => null,
    completarLeccionActual: async () => null,
  },
});
// El mock reemplaza el módulo COMPLETO, así que hay que incluir también lo que consume
// flows/evaluacion (importado en cadena por el toolRunner) o la carga falla al resolver.
mock.module('../src/store/evaluaciones.ts', {
  namedExports: {
    quizDeLeccion: async () => null,
    quizzesPendientes: async () => pendientes,
    quizParaIniciar: async () => null,
    iniciarAttempt: async () => null,
    registrarRespuesta: async () => null,
  },
});
mock.module('../src/rag/retrieval.ts', {
  namedExports: { buscarContenidoCurso: async () => ({ encontrado: false, disponible: false, resultados: [] }) },
});

const { executeTool } = await import('../src/ai/toolRunner');
const CTX = { conversationId: '+56900070001', personId: 'p1' } as any;

test('consultar_progreso informa los quizzes pendientes', async () => {
  pendientes = 6;
  const r: any = await executeTool('consultar_progreso', {}, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.completadas, 9);
  assert.equal(r.quizzesPendientes, 6);
  assert.match(String(r.instruccionPractica), /quiz/i);
});

test('continuar_curso, con el curso terminado, ofrece la práctica en vez de dejarlo sin nada', async () => {
  pendientes = 6;
  const r: any = await executeTool('continuar_curso', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sin_leccion_pendiente');
  assert.equal(r.quizzesPendientes, 6, 'es lo único que todavía puede hacer');
  assert.match(String(r.instruccionPractica), /quiz/i);
});

test('sin quizzes pendientes el campo NO aparece', async () => {
  // Un cero en el resultado gastaría tokens y le daría al modelo algo que ofrecer sin sustancia.
  pendientes = 0;
  for (const tool of ['consultar_progreso', 'continuar_curso']) {
    const r: any = await executeTool(tool, {}, CTX);
    assert.equal('quizzesPendientes' in r, false, `${tool} no debe traer el campo`);
    assert.equal('instruccionPractica' in r, false);
  }
});

test('el singular y el plural se escriben bien', async () => {
  pendientes = 1;
  const uno: any = await executeTool('consultar_progreso', {}, CTX);
  assert.match(String(uno.instruccionPractica), /1 mini-quiz\b/);
  assert.doesNotMatch(String(uno.instruccionPractica), /1 mini-quizzes/);
  pendientes = 3;
  const varios: any = await executeTool('consultar_progreso', {}, CTX);
  assert.match(String(varios.instruccionPractica), /3 mini-quizzes/);
});

test('la instrucción pide ofrecerlo UNA vez, no insistir', async () => {
  // Con 6 pendientes y sin esta indicación, el tutor cerraría cada mensaje ofreciendo lo mismo.
  pendientes = 6;
  const r: any = await executeTool('consultar_progreso', {}, CTX);
  const i = String(r.instruccionPractica);
  assert.match(i, /UNA frase|una frase/);
  assert.match(i, /no insistas|No insistas/i);
});
