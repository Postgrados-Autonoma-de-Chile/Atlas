import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Tools académicas del tutor (Fase 4) contra un curso SIMULADO en memoria (3 microcápsulas de 6 min):
// inscripción, progreso, entrega, completar (acumula minutos) y detección de fin de curso.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

type Sim = { inscrito: boolean; completadas: number; minutos: number; estado: 'activa' | 'completada' };
const LECCIONES = [
  { orden: 1, titulo: '¿Qué es la inteligencia artificial?', duracionMin: 6 },
  { orden: 2, titulo: 'IA en el celular, redes sociales y aplicaciones', duracionMin: 6 },
  { orden: 3, titulo: 'Actividad de cierre', duracionMin: 10 },
];
/** Avance en una versión archivada del programa, para el caso de quien venía cursando. */
let previoSim: { curso: string; completadas: number; total: number; folio: string | null } | null = null;
const sims = new Map<string, Sim>();
const sim = (personId: string): Sim => {
  if (!sims.has(personId)) sims.set(personId, { inscrito: false, completadas: 0, minutos: 0, estado: 'activa' });
  return sims.get(personId)!;
};
const estadoDe = (s: Sim) => ({
  inscrito: s.inscrito,
  ...(s.inscrito
    ? {
        curso: { id: 'c1', codigo: 'NIVEL-INICIAL-P1', nombre: 'IA en la vida cotidiana', duracionMin: 22 },
        enrollment: { id: 'e1', estado: s.estado, minutosAcumulados: s.minutos },
        totalLecciones: LECCIONES.length,
        completadas: s.completadas,
        proxima: LECCIONES[s.completadas]
          ? { orden: LECCIONES[s.completadas].orden, titulo: LECCIONES[s.completadas].titulo, tipo: 'capsula', duracionMin: LECCIONES[s.completadas].duracionMin }
          : undefined,
      }
    : {}),
});

mock.module('../src/store/cursos.ts', {
  namedExports: {
    // El mock reemplaza el módulo COMPLETO: sin estos dos, el toolRunner no resuelve sus imports.
    avancePrevioArchivado: async () => previoSim,
    frasePrevio: (p: any) => `Ya había avanzado ${p.completadas} de ${p.total}. NO se traslada.`,
    cursoActivo: async () => ({ id: 'c1', codigo: 'NIVEL-INICIAL-P1', nombre: 'IA en la vida cotidiana', descripcion: '', duracionMin: 22 }),
    inscribir: async (personId: string) => ((sim(personId).inscrito = true), estadoDe(sim(personId))),
    estadoAcademico: async (personId: string) => estadoDe(sim(personId)),
    entregarLeccionActual: async (personId: string) => {
      const s = sim(personId);
      const l = s.inscrito && s.estado === 'activa' ? LECCIONES[s.completadas] : undefined;
      if (!l) return null;
      return {
        posicion: `${l.orden} de ${LECCIONES.length}`,
        leccion: { id: 'l' + l.orden, orden: l.orden, titulo: l.titulo, descripcion: 'desc', tipo: 'capsula', duracionMin: l.duracionMin, materiales: [{ tipo: 'video', titulo: l.titulo, url: 'https://video/' + l.orden }] },
      };
    },
    completarLeccionActual: async (personId: string) => {
      const s = sim(personId);
      const l = s.inscrito && s.estado === 'activa' ? LECCIONES[s.completadas] : undefined;
      if (!l) return null;
      s.completadas++;
      s.minutos += l.duracionMin;
      const fin = s.completadas >= LECCIONES.length;
      if (fin) s.estado = 'completada';
      return {
        completada: { orden: l.orden, titulo: l.titulo },
        minutosAcumulados: s.minutos,
        cursoCompletado: fin,
        siguiente: fin ? undefined : { orden: LECCIONES[s.completadas].orden, titulo: LECCIONES[s.completadas].titulo },
      };
    },
    contextoAcademico: async () => 'ctx',
  },
});
mock.module('../src/store/personas.ts', {
  namedExports: {
    buscarPersonaPorWaId: async () => null,
    crearPersonaRegistrada: async () => null,
    registrarOptOut: async () => true,
  },
});
mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});

const { executeTool } = await import('../src/ai/toolRunner');
const ctx = (personId?: string) => ({ profile: {} as any, conversationId: '+56900020001', personId });

test('sin registro: las tools académicas piden registrarse', async () => {
  const r: any = await executeTool('consultar_progreso', {}, ctx(undefined));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_registrado');
});

test('flujo académico completo: inscribir → progreso → continuar → completar ×3 → fin de curso', async () => {
  const c = ctx('alumno-1');

  const ins: any = await executeTool('inscribirme_al_curso', {}, c);
  assert.equal(ins.ok, true);
  assert.equal(ins.curso, 'IA en la vida cotidiana');
  assert.equal(ins.totalMicrocapsulas, 3);
  assert.equal(ins.primera.orden, 1);

  const prog: any = await executeTool('consultar_progreso', {}, c);
  assert.equal(prog.completadas, 0);
  assert.equal(prog.minutosAcumulados, 0);

  const ent: any = await executeTool('continuar_curso', {}, c);
  assert.equal(ent.ok, true);
  assert.equal(ent.posicion, '1 de 3');
  assert.equal(ent.leccion.materiales[0].url, 'https://video/1');

  const c1: any = await executeTool('completar_leccion', {}, c);
  assert.equal(c1.completada.orden, 1);
  assert.equal(c1.minutosAcumulados, 6);
  assert.equal(c1.cursoCompletado, false);
  assert.equal(c1.siguiente.orden, 2);

  await executeTool('completar_leccion', {}, c);
  const c3: any = await executeTool('completar_leccion', {}, c);
  assert.equal(c3.cursoCompletado, true, 'la última microcápsula completa el curso');
  assert.equal(c3.minutosAcumulados, 22, 'acumula 6+6+10 minutos');
  assert.equal(c3.siguiente, null);
  assert.match(c3.mensaje, /certificado/i);

  const fin: any = await executeTool('continuar_curso', {}, c);
  assert.equal(fin.ok, false, 'curso completado: no hay lección pendiente');
  assert.equal(fin.error, 'sin_leccion_pendiente');
});

test('consultar_progreso refleja el estado real tras avanzar', async () => {
  const c = ctx('alumno-2');
  await executeTool('inscribirme_al_curso', {}, c);
  await executeTool('completar_leccion', {}, c);
  const prog: any = await executeTool('consultar_progreso', {}, c);
  assert.equal(prog.completadas, 1);
  assert.equal(prog.total, 3);
  assert.equal(prog.minutosAcumulados, 6);
  assert.equal(prog.proxima.orden, 2);
});

test('quien venía de una versión anterior recibe el reconocimiento al inscribirse', async () => {
  // Al cambiar al plan oficial, 13 personas quedaron colgando del curso archivado. Sin este dato,
  // el tutor saluda como nueva a alguien que ya había hecho tres microcápsulas.
  previoSim = { curso: 'IA en la vida cotidiana', completadas: 3, total: 9, folio: null };
  const c = ctx('alumno-previo');
  const ins: any = await executeTool('inscribirme_al_curso', {}, c);
  assert.equal(ins.ok, true, 'se inscribe igual: el avance viejo no lo exime');
  assert.deepEqual(ins.versionAnterior, { curso: 'IA en la vida cotidiana', completadas: 3, total: 9, certificado: null });
  assert.match(String(ins.instruccionVersionAnterior), /NO se traslada/);

  const prog: any = await executeTool('consultar_progreso', {}, c);
  assert.equal(prog.completadas, 0, 'parte de cero en el curso nuevo');

  previoSim = null;
  const limpio: any = await executeTool('inscribirme_al_curso', {}, ctx('alumno-limpio'));
  assert.equal('versionAnterior' in limpio, false, 'sin avance previo el campo no aparece');
});

test('el reconocimiento también llega por continuar_curso, no solo al inscribirse', async () => {
  // Quien venía cursando escribe "continuar", no "inscríbeme": es el camino más probable, y la
  // rehidratación no lo cubre porque solo se inyecta con la memoria vacía.
  previoSim = { curso: 'IA en la vida cotidiana', completadas: 9, total: 9, folio: 'ATLAS-2026-0002' };
  const c = ctx('alumno-certificado');
  const r: any = await executeTool('continuar_curso', {}, c);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sin_leccion_pendiente');
  assert.equal(r.versionAnterior.certificado, 'ATLAS-2026-0002');
  previoSim = null;
});
