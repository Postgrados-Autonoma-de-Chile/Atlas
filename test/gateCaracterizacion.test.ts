import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Caso 6: alguien intenta saltarse contenidos. Debe respetarse la lógica curricular.
//
// FUENTE: "Cuestionario de Caracterización (Ajustado).docx" — el plan lo define como el paso
// inicial de la experiencia formativa: «realizar la caracterización inicial de las actividades de
// capacitación». Sin él, la ruta no empieza.
//
// El bloqueo vive en las HERRAMIENTAS, no en el prompt: si dependiera del prompt, bastaría con
// insistir para que el modelo cediera y entregara contenido, y el requisito del plan quedaría a
// merced de lo persuasivo que sea el estudiante.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let completa = false;
let hechas = 0;
let total = 11;
let entregas = 0;
let inscripciones = 0;

const ESTADO = {
  inscrito: true,
  curso: { id: 'c1', codigo: 'NIVEL-1-IA-PROBLEMAS', nombre: 'Nivel Inicial: Alfabetización ciudadana en Inteligencia Artificial', duracionMin: 55 },
  enrollment: { id: 'e1', estado: 'activa', minutosAcumulados: 0 },
  totalLecciones: 8,
  completadas: 0,
  proxima: { orden: 1, titulo: 'IA como apoyo para resolver problemas cotidianos', tipo: 'capsula', duracionMin: 6 },
};

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/personas.ts', {
  namedExports: { buscarPersonaPorWaId: async () => null },
});
mock.module('../src/store/caracterizacion.ts', {
  namedExports: {
    estaCompleta: async () => completa,
    respondidas: async () => hechas,
    totalPreguntas: async () => total,
  },
});
mock.module('../src/store/cursos.ts', {
  namedExports: {
    cursoActivo: async () => ESTADO.curso,
    inscribir: async () => (inscripciones++, ESTADO),
    estadoAcademico: async () => ESTADO,
    entregarLeccionActual: async () => {
      entregas++;
      return {
        posicion: '1 de 8',
        leccion: {
          id: 'l1', orden: 1, titulo: ESTADO.proxima.titulo, descripcion: null, tipo: 'capsula',
          duracionMin: 6, materiales: [], pasoRuta: 'ENTRADA',
          proposito: null, preguntaMovilizadora: null, productoEvidencia: null,
          resultadosObservables: [], guionApertura: null, guionCierre: null,
        },
      };
    },
    completarLeccionActual: async () => null,
    contextoAcademico: async () => 'ctx',
  },
});
mock.module('../src/store/evaluaciones.ts', {
  namedExports: {
    quizDeLeccion: async () => null,
    quizzesPendientes: async () => 0,
    quizParaIniciar: async () => null,
    iniciarAttempt: async () => null,
    registrarRespuesta: async () => null,
  },
});
mock.module('../src/rag/retrieval.ts', {
  namedExports: { buscarContenidoCurso: async () => ({ encontrado: false, disponible: false, resultados: [] }) },
});

const { executeTool } = await import('../src/ai/toolRunner');
const CTX = { conversationId: '+56900120001', personId: 'p1' } as any;
const reset = () => { completa = false; hechas = 0; total = 11; entregas = 0; inscripciones = 0; };

test('caso 6 — sin caracterización, inscribirse y continuar quedan bloqueados', async () => {
  reset();
  hechas = 3;
  for (const tool of ['inscribirme_al_curso', 'continuar_curso']) {
    const r: any = await executeTool(tool, {}, CTX);
    assert.equal(r.ok, false, `${tool} no debe proceder`);
    assert.equal(r.error, 'caracterizacion_pendiente');
    assert.equal(r.faltan, 8, 'le quedan 8 de 11');
    assert.match(String(r.mensaje), /cuestionario/i, 'y el tutor sabe qué pedirle');
  }
  assert.equal(entregas, 0, 'no se entregó ninguna microcápsula');
  assert.equal(inscripciones, 0, 'ni se creó la inscripción');
});

test('caso 6 — insistir no sirve: el bloqueo no está en el prompt sino en el estado', async () => {
  // Tres intentos seguidos, como haría alguien que insiste (o un modelo demasiado complaciente).
  reset();
  for (let i = 0; i < 3; i++) {
    const r: any = await executeTool('continuar_curso', {}, CTX);
    assert.equal(r.error, 'caracterizacion_pendiente', `intento ${i + 1}`);
  }
  assert.equal(entregas, 0);
});

test('completada la caracterización, la ruta se abre', async () => {
  reset();
  completa = true;
  const ins: any = await executeTool('inscribirme_al_curso', {}, CTX);
  assert.equal(ins.ok, true);
  const cont: any = await executeTool('continuar_curso', {}, CTX);
  assert.equal(cont.ok, true);
  assert.equal(cont.posicion, '1 de 8');
  assert.equal(cont.leccion.pasoRuta, 'ENTRADA', 'y arranca por la primera de la ruta');
  assert.equal(entregas, 1);
});

test('sin cuestionario cargado en la base, no se bloquea nada', async () => {
  // Una base sin currículo dejaría el bot inservible: un requisito que no existe no puede exigirse.
  reset();
  total = 0;
  const r: any = await executeTool('continuar_curso', {}, CTX);
  assert.equal(r.ok, true);
  assert.equal(entregas, 1);
});

test('consultar_progreso sigue respondiendo: informarse no es saltarse la ruta', async () => {
  // Bloquear también la consulta dejaría a la persona sin saber por qué no avanza.
  reset();
  hechas = 1;
  const r: any = await executeTool('consultar_progreso', {}, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.total, 8);
});
