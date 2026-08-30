import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Tool buscar_contenido_curso (Fase 5): citas cuando hay material, honestidad cuando no,
// y degradación limpia cuando el RAG no está operativo. Retrieval y cursos SIMULADOS.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let resultadoRag: any = { disponible: true, encontrado: true, resultados: [] };
const consultasVistas: string[] = [];

mock.module('../src/rag/retrieval.ts', {
  namedExports: {
    buscarContenidoCurso: async (_cursoId: string, consulta: string) => {
      consultasVistas.push(consulta);
      return resultadoRag;
    },
  },
});
mock.module('../src/store/cursos.ts', {
  namedExports: {
    cursoActivo: async () => ({ id: 'c1', codigo: 'NIVEL-INICIAL-P1', nombre: 'IA en la vida cotidiana', descripcion: '', duracionMin: 58 }),
    inscribir: async () => null,
    estadoAcademico: async () => ({ inscrito: false }),
    entregarLeccionActual: async () => null,
    completarLeccionActual: async () => null,
    contextoAcademico: async () => 'ctx',
  },
});
mock.module('../src/store/personas.ts', {
  namedExports: { buscarPersonaPorWaId: async () => null, crearPersonaRegistrada: async () => null, registrarOptOut: async () => true },
});
mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});

const { executeTool } = await import('../src/ai/toolRunner');
const ctx = { profile: {} as any, conversationId: '+56900030001', personId: undefined };

test('material encontrado: devuelve fragmentos con fuente e instrucción de citar', async () => {
  resultadoRag = {
    disponible: true,
    encontrado: true,
    resultados: [
      { texto: 'La IA aprende a partir de datos…', fuente: 'Microcápsula 1: ¿Qué es la inteligencia artificial?', leccionOrden: 1, similitud: 0.81 },
      { texto: 'Entregar contexto y objetivo…', fuente: 'Microcápsula 5: Cómo hacer una buena pregunta a una IA', leccionOrden: 5, similitud: 0.66 },
    ],
  };
  const r: any = await executeTool('buscar_contenido_curso', { consulta: '¿cómo aprende la IA?' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.encontrado, true);
  assert.equal(r.fragmentos.length, 2);
  assert.match(r.fragmentos[0].fuente, /Microcápsula 1/);
  assert.match(r.instruccion, /cita la fuente/i);
  assert.equal(consultasVistas.at(-1), '¿cómo aprende la IA?');
});

test('material NO encontrado: instruye honestidad, jamás inventar', async () => {
  resultadoRag = { disponible: true, encontrado: false, resultados: [] };
  const r: any = await executeTool('buscar_contenido_curso', { consulta: 'física cuántica avanzada' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.encontrado, false);
  assert.match(r.mensaje, /NO cubre/i);
  assert.match(r.mensaje, /honestamente/i);
});

test('RAG no disponible (sin BD o sin API key): error controlado, no silencio', async () => {
  resultadoRag = { disponible: false, encontrado: false, resultados: [] };
  const r: any = await executeTool('buscar_contenido_curso', { consulta: 'sesgos de la IA' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'rag_no_disponible');
});

test('consulta demasiado corta: rechazada antes de llamar al retrieval', async () => {
  const antes = consultasVistas.length;
  const r: any = await executeTool('buscar_contenido_curso', { consulta: 'ia' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'consulta_invalida');
  assert.equal(consultasVistas.length, antes, 'no llegó al retrieval');
});
