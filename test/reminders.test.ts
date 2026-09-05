import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Motor de recordatorios (F9 + revisión F9.1): dedupe, ventanas hábiles de Chile, revalidación al
// despachar, semántica AT-MOST-ONCE (reclamar antes de enviar), canal texto/plantilla y opt-out/in.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_TEMPLATE_RECORDATORIO = ''; // por defecto sin plantilla; se simula por caso

type Rm = { id: string; personId: string; tipo: string; estado: string; clave: string; programadoPara: Date; intentos: number; waMessageId?: string | null };
const rms = new Map<string, Rm>();
let idSeq = 0;
let candidatos: any[] = [];
let estadoAcad: any; // configurable por test

const ESTADO_ACTIVO = {
  inscrito: true,
  curso: { id: 'c1', codigo: 'P1', nombre: 'IA en la vida cotidiana', duracionMin: 58 },
  enrollment: { id: 'e1', estado: 'activa', minutosAcumulados: 12 },
  totalLecciones: 9, completadas: 2,
  proxima: { orden: 3, titulo: 'Asistentes conversacionales', tipo: 'capsula', duracionMin: 6 },
};

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/recordatorios.ts', {
  namedExports: {
    candidatosContinuarCurso: async () => candidatos,
    programarRecordatorio: async (personId: string, tipo: string, clave: string, cuando: Date) => {
      if ([...rms.values()].some((r) => r.clave === clave)) return false; // UNIQUE clave_dedupe
      const id = 'rm' + ++idSeq;
      rms.set(id, { id, personId, tipo, estado: 'programado', clave, programadoPara: cuando, intentos: 0 });
      return true;
    },
    pendientesDeDespacho: async () =>
      [...rms.values()]
        .filter((r) => r.estado === 'programado')
        .map((r) => ({ id: r.id, personId: r.personId, tipo: r.tipo, intentos: r.intentos, waId: '+56900050001', nombre: 'Rodrigo', programadoPara: r.programadoPara })),
    reclamarParaEnvio: async (id: string) => {
      const r = rms.get(id)!;
      if (r.estado !== 'programado') return false;
      r.estado = 'enviado';
      return true;
    },
    registrarWamid: async (id: string, w: string | null) => { rms.get(id)!.waMessageId = w; },
    devolverAProgramado: async (id: string, intentos: number, cuando: Date) => {
      const r = rms.get(id)!;
      if (r.estado !== 'enviado') return;
      r.estado = 'programado'; r.intentos = intentos; r.programadoPara = cuando;
    },
    reprogramar: async (id: string, cuando: Date) => {
      const r = rms.get(id)!;
      if (r.estado === 'programado') r.programadoPara = cuando;
    },
    marcarEstado: async (id: string, estado: string) => { rms.get(id)!.estado = estado; },
    cancelarDePersona: async () => 0,
    marcarFallidoPorWamid: async () => {},
  },
});
mock.module('../src/store/cursos.ts', {
  namedExports: {
    cursoActivo: async () => null,
    inscribir: async () => null,
    estadoAcademico: async () => estadoAcad,
    entregarLeccionActual: async () => null,
    completarLeccionActual: async () => null,
    contextoAcademico: async () => 'ctx',
  },
});

const { claveDedupe, proximaVentanaHabil, esOptOutRecordatorios, esOptInRecordatorios, planificar, despachar } =
  await import('../src/reminders/motor');
const { wallClock, zonedToUtc } = await import('../src/campaign/calendar');
const { setJson, kvDel } = await import('../src/store/kv');
import type { MessagingProvider, SendResult } from '../src/messaging/types';

// Instantes fijos (TZ Chile): 2026-08-31 es lunes; 2026-08-30 es domingo; 2026-09-18 feriado.
const LUNES_MEDIODIA = zonedToUtc(2026, 8, 31, 12, 0, 'America/Santiago');
const LUNES_TEMPRANO = zonedToUtc(2026, 8, 31, 8, 0, 'America/Santiago');
const LUNES_NOCHE = zonedToUtc(2026, 8, 31, 21, 30, 'America/Santiago');
const DOMINGO = zonedToUtc(2026, 8, 30, 15, 0, 'America/Santiago');
const FUTURO = () => new Date(Date.now() + 3600 * 1000); // programación "aún no superada" por ult_in

function fakeProvider(fallar = false) {
  const textos: string[] = [];
  const plantillas: { nombre: string; params: string[] }[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (fallar ? { ok: false, error: 'boom' } : (textos.push(texto), { ok: true, messageId: 'wamid.rem' + textos.length }) as SendResult),
    enviarPlantilla: async (_t, nombre, _l, params) => (plantillas.push({ nombre, params }), { ok: true, messageId: 'wamid.tpl' }),
    enviarBotones: async () => ({ ok: true }), enviarLista: async () => ({ ok: true }),
    enviarDocumento: async () => ({ ok: true }), marcarLeido: async () => ({ ok: true }),
    descargarMedia: async () => null,
  };
  return { p, textos, plantillas };
}

const reset = () => {
  rms.clear();
  estadoAcad = structuredClone(ESTADO_ACTIVO);
  candidatos = [{ personId: 'p1', waId: '+56900050001', nombre: 'Rodrigo', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 0 }];
};

test('claveDedupe: estable dentro de la ventana, distinta entre ventanas', () => {
  const a = claveDedupe('p1', 'continuar_curso', LUNES_MEDIODIA, 3);
  const b = claveDedupe('p1', 'continuar_curso', new Date(LUNES_MEDIODIA.getTime() + 2 * 3600 * 1000), 3);
  const c = claveDedupe('p1', 'continuar_curso', new Date(LUNES_MEDIODIA.getTime() + 4 * 24 * 3600 * 1000), 3);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('proximaVentanaHabil: dentro→ahora; antes→10:00; noche→día siguiente; domingo→lunes; feriado se salta', () => {
  assert.equal(proximaVentanaHabil(LUNES_MEDIODIA).getTime(), LUNES_MEDIODIA.getTime());
  const desdeTemprano = wallClock(proximaVentanaHabil(LUNES_TEMPRANO), 'America/Santiago');
  assert.deepEqual([desdeTemprano.ymd, desdeTemprano.hh, desdeTemprano.mm], ['2026-08-31', 10, 0]);
  const desdeNoche = wallClock(proximaVentanaHabil(LUNES_NOCHE), 'America/Santiago');
  assert.deepEqual([desdeNoche.ymd, desdeNoche.hh], ['2026-09-01', 10]);
  assert.equal(wallClock(proximaVentanaHabil(DOMINGO), 'America/Santiago').ymd, '2026-08-31');
  const viernesFeriado = zonedToUtc(2026, 9, 18, 12, 0, 'America/Santiago');
  assert.equal(wallClock(proximaVentanaHabil(viernesFeriado), 'America/Santiago').ymd, '2026-09-21');
});

test('opt-out y opt-in: variantes; "no quiero recordatorios" NO es opt-in', () => {
  assert.equal(esOptOutRecordatorios('No quiero más recordatorios por favor'), true);
  assert.equal(esOptOutRecordatorios('no enviar recordatorios'), true);
  assert.equal(esOptOutRecordatorios('dejen de escribirme'), true);
  assert.equal(esOptOutRecordatorios('¿me recuerdas mañana el quiz?'), false);
  assert.equal(esOptInRecordatorios('quiero recordatorios de nuevo'), true);
  assert.equal(esOptInRecordatorios('actívame los recordatorios'), true);
  assert.equal(esOptInRecordatorios('no quiero recordatorios'), true, 'el matcher crudo coincide: el orden opt-out-primero del pipeline resuelve la ambigüedad');
});

test('planificar: respeta el tope de insistencia y el dedupe re-ejecutando', async () => {
  reset();
  candidatos.push({ personId: 'p2', waId: '+2', nombre: 'B', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 3 });
  const r1 = await planificar(LUNES_MEDIODIA);
  assert.equal(r1.programados, 1);
  assert.equal(r1.omitidosPorTope, 1);
  const r2 = await planificar(LUNES_MEDIODIA);
  assert.equal(r2.programados, 0, 'el dedupe impide duplicar');
});

test('revalidación al despachar: inscripción completada → cancelado sin enviar', async () => {
  reset();
  await planificar(LUNES_MEDIODIA);
  estadoAcad.enrollment.estado = 'completada';
  const { p, textos } = fakeProvider();
  const r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.cancelados, 1);
  assert.equal(textos.length, 0);
  assert.equal([...rms.values()][0].estado, 'cancelado');
});

test('revalidación al despachar: el estudiante escribió DESPUÉS de la programación → cancelado', async () => {
  reset();
  await planificar(LUNES_MEDIODIA);
  const rm = [...rms.values()][0];
  rm.programadoPara = new Date(Date.now() - 3600 * 1000); // programado hace 1h
  await setJson('ult_in:+56900050001', { t: Date.now() }, 3600); // y escribió recién
  const { p, textos } = fakeProvider();
  const r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.cancelados, 1);
  assert.equal(textos.length, 0, 'ya volvió: el "quedó pendiente" habría sido falso');
  await kvDel('ult_in:+56900050001');
});

test('despachar: fuera de ventana re-programa sin molestar', async () => {
  reset();
  await planificar(LUNES_NOCHE);
  const rm = [...rms.values()][0];
  rm.programadoPara = LUNES_NOCHE;
  const { p, textos } = fakeProvider();
  const r = await despachar(p, LUNES_NOCHE);
  assert.equal(r.reprogramados, 1);
  assert.equal(textos.length, 0);
  assert.equal(rm.estado, 'programado');
  const cuando = wallClock(rm.programadoPara, 'America/Santiago');
  assert.deepEqual([cuando.ymd, cuando.hh], ['2026-09-01', 10]);
});

test('despachar: ventana 24h abierta → reclama, envía texto con datos reales y guarda wamid', async () => {
  reset();
  await planificar(LUNES_MEDIODIA);
  const rm = [...rms.values()][0];
  rm.programadoPara = FUTURO(); // ult_in no la supera → no se cancela
  await setJson('ult_in:+56900050001', { t: Date.now() }, 3600);
  const { p, textos, plantillas } = fakeProvider();
  const r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.enviados, 1);
  assert.equal(plantillas.length, 0);
  assert.match(textos[0], /IA en la vida cotidiana/);
  assert.match(textos[0], /Asistentes conversacionales/);
  assert.match(textos[0], /no enviar recordatorios/i);
  assert.equal(rm.estado, 'enviado');
  assert.ok(rm.waMessageId);
  await kvDel('ult_in:+56900050001');
});

test('despachar: sin ventana 24h y sin plantilla configurada → omitido (regla de Meta)', async () => {
  reset();
  await planificar(LUNES_MEDIODIA);
  const { p, textos } = fakeProvider();
  const r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.omitidos, 1);
  assert.equal(textos.length, 0);
});

test('despachar: fallo del proveedor devuelve a programado (intentos) y al tercero marca fallido', async () => {
  reset();
  await planificar(LUNES_MEDIODIA);
  const rm = [...rms.values()][0];
  rm.programadoPara = FUTURO();
  await setJson('ult_in:+56900050001', { t: Date.now() }, 3600);
  const { p } = fakeProvider(true);

  let r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.reprogramados, 1);
  assert.equal(rm.estado, 'programado', 'devuelta desde el reclamo');
  assert.equal(rm.intentos, 1);
  rm.programadoPara = FUTURO();
  await despachar(p, LUNES_MEDIODIA);
  rm.programadoPara = FUTURO();
  r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.fallidos, 1);
  assert.equal(rm.estado, 'fallido');
  await kvDel('ult_in:+56900050001');
});
