import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Motor de recordatorios (Fase 9): dedupe por clave, ventanas hábiles de Chile, elección de canal
// (texto en ventana 24h / plantilla utility fuera), tope de insistencia, fallos y opt-out.
// Repos SIMULADOS; el reloj se controla con fechas fijas (2026-08-31 = lunes en Chile).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_TEMPLATE_RECORDATORIO = ''; // por defecto sin plantilla; se simula por caso

type Rm = { id: string; personId: string; tipo: string; estado: string; clave: string; programadoPara: Date; intentos: number; waMessageId?: string | null };
const rms = new Map<string, Rm>();
let idSeq = 0;
let candidatos: any[] = [];

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
        .filter((r) => r.estado === 'programado' && r.programadoPara.getTime() <= Date.now() + 365 * 24 * 3600 * 1000)
        .map((r) => ({ id: r.id, personId: r.personId, tipo: r.tipo, intentos: r.intentos, waId: '+56900050001', nombre: 'Rodrigo' })),
    transicionar: async (id: string, cambios: any) => {
      const r = rms.get(id)!;
      if (r.estado !== 'programado') return;
      if (cambios.estado) r.estado = cambios.estado;
      if (cambios.intentos !== undefined) r.intentos = cambios.intentos;
      if (cambios.programadoPara) r.programadoPara = cambios.programadoPara;
      if (cambios.waMessageId !== undefined) r.waMessageId = cambios.waMessageId;
    },
    cancelarDePersona: async () => 0,
    marcarFallidoPorWamid: async () => {},
  },
});
mock.module('../src/store/cursos.ts', {
  namedExports: {
    cursoActivo: async () => null,
    inscribir: async () => null,
    estadoAcademico: async () => ({
      inscrito: true,
      curso: { id: 'c1', codigo: 'P1', nombre: 'IA en la vida cotidiana', duracionMin: 58 },
      enrollment: { id: 'e1', estado: 'activa', minutosAcumulados: 12 },
      totalLecciones: 9, completadas: 2,
      proxima: { orden: 3, titulo: 'Asistentes conversacionales', tipo: 'capsula', duracionMin: 6 },
    }),
    entregarLeccionActual: async () => null,
    completarLeccionActual: async () => null,
    contextoAcademico: async () => 'ctx',
  },
});

const { claveDedupe, proximaVentanaHabil, esOptOutRecordatorios, planificar, despachar, AGENDA_RECORDATORIOS } =
  await import('../src/reminders/motor');
const { wallClock, zonedToUtc } = await import('../src/campaign/calendar');
const { setJson, kvDel } = await import('../src/store/kv');
import type { MessagingProvider, SendResult } from '../src/messaging/types';

// Instantes fijos (TZ Chile): 2026-08-31 es lunes; 2026-08-30 es domingo; 2026-09-18 feriado.
const LUNES_MEDIODIA = zonedToUtc(2026, 8, 31, 12, 0, 'America/Santiago');
const LUNES_TEMPRANO = zonedToUtc(2026, 8, 31, 8, 0, 'America/Santiago');
const LUNES_NOCHE = zonedToUtc(2026, 8, 31, 21, 30, 'America/Santiago');
const DOMINGO = zonedToUtc(2026, 8, 30, 15, 0, 'America/Santiago');

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

test('claveDedupe: estable dentro de la ventana, distinta entre ventanas', () => {
  const a = claveDedupe('p1', 'continuar_curso', LUNES_MEDIODIA, 3);
  const b = claveDedupe('p1', 'continuar_curso', new Date(LUNES_MEDIODIA.getTime() + 2 * 3600 * 1000), 3);
  const c = claveDedupe('p1', 'continuar_curso', new Date(LUNES_MEDIODIA.getTime() + 4 * 24 * 3600 * 1000), 3);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('proximaVentanaHabil: dentro→ahora; antes→apertura 10:00; noche→día siguiente; domingo→lunes; feriado se salta', () => {
  assert.equal(proximaVentanaHabil(LUNES_MEDIODIA).getTime(), LUNES_MEDIODIA.getTime());

  const desdeTemprano = wallClock(proximaVentanaHabil(LUNES_TEMPRANO), 'America/Santiago');
  assert.deepEqual([desdeTemprano.ymd, desdeTemprano.hh, desdeTemprano.mm], ['2026-08-31', 10, 0]);

  const desdeNoche = wallClock(proximaVentanaHabil(LUNES_NOCHE), 'America/Santiago');
  assert.deepEqual([desdeNoche.ymd, desdeNoche.hh], ['2026-09-01', 10]);

  const desdeDomingo = wallClock(proximaVentanaHabil(DOMINGO), 'America/Santiago');
  assert.equal(desdeDomingo.ymd, '2026-08-31'); // lunes

  const viernesFeriado = zonedToUtc(2026, 9, 18, 12, 0, 'America/Santiago'); // feriado en la agenda
  const desdeFeriado = wallClock(proximaVentanaHabil(viernesFeriado), 'America/Santiago');
  assert.equal(desdeFeriado.ymd, '2026-09-21'); // 19 sáb feriado, 20 dom → lunes 21
});

test('esOptOutRecordatorios: variantes con y sin acento; negativos no gatillan', () => {
  assert.equal(esOptOutRecordatorios('No quiero más recordatorios por favor'), true);
  assert.equal(esOptOutRecordatorios('no enviar recordatorios'), true);
  assert.equal(esOptOutRecordatorios('dejen de escribirme'), true);
  assert.equal(esOptOutRecordatorios('¿me recuerdas mañana el quiz?'), false);
  assert.equal(esOptOutRecordatorios('quiero continuar el curso'), false);
});

test('planificar: respeta el tope de insistencia y el dedupe re-ejecutando', async () => {
  rms.clear();
  candidatos = [
    { personId: 'p1', waId: '+1', nombre: 'A', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 0 },
    { personId: 'p2', waId: '+2', nombre: 'B', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 3 }, // tope
  ];
  const r1 = await planificar(LUNES_MEDIODIA);
  assert.equal(r1.programados, 1);
  assert.equal(r1.omitidosPorTope, 1);
  const r2 = await planificar(LUNES_MEDIODIA); // mismo bloque temporal → clave repetida
  assert.equal(r2.programados, 0, 'el dedupe impide duplicar');
});

test('despachar: fuera de ventana re-programa sin molestar', async () => {
  rms.clear();
  candidatos = [{ personId: 'p1', waId: '+1', nombre: 'A', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 0 }];
  await planificar(LUNES_NOCHE); // programado para martes 10:00
  // Forzamos que esté "vencido" para el despachador nocturno:
  const rm = [...rms.values()][0];
  rm.programadoPara = LUNES_NOCHE;
  const { p, textos } = fakeProvider();
  const r = await despachar(p, LUNES_NOCHE);
  assert.equal(r.reprogramados, 1);
  assert.equal(textos.length, 0, 'no envió nada a las 21:30');
  assert.equal(rm.estado, 'programado');
  const cuando = wallClock(rm.programadoPara, 'America/Santiago');
  assert.deepEqual([cuando.ymd, cuando.hh], ['2026-09-01', 10]);
});

test('despachar: ventana 24h abierta → texto gratis con datos reales del curso', async () => {
  rms.clear();
  candidatos = [{ personId: 'p1', waId: '+56900050001', nombre: 'Rodrigo', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 0 }];
  await planificar(LUNES_MEDIODIA);
  await setJson('ult_in:+56900050001', { t: Date.now() }, 3600); // habló hace poco → 24h abierta
  const { p, textos, plantillas } = fakeProvider();
  const r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.enviados, 1);
  assert.equal(plantillas.length, 0);
  assert.match(textos[0], /IA en la vida cotidiana/);
  assert.match(textos[0], /Asistentes conversacionales/);
  assert.match(textos[0], /no enviar recordatorios/i, 'incluye cómo hacer opt-out');
  const rm = [...rms.values()][0];
  assert.equal(rm.estado, 'enviado');
  assert.ok(rm.waMessageId, 'guarda el wamid para correlacionar statuses');
  await kvDel('ult_in:+56900050001');
});

test('despachar: sin ventana 24h y sin plantilla configurada → omitido (regla de Meta)', async () => {
  rms.clear();
  candidatos = [{ personId: 'p1', waId: '+56900050001', nombre: 'R', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 0 }];
  await planificar(LUNES_MEDIODIA);
  const { p, textos } = fakeProvider();
  const r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.omitidos, 1);
  assert.equal(textos.length, 0);
});

test('despachar: fallo del proveedor reintenta (30 min) y al tercer intento marca fallido', async () => {
  rms.clear();
  candidatos = [{ personId: 'p1', waId: '+56900050001', nombre: 'R', cursoNombre: 'C', proximaLeccion: null, enviadosSinActividad: 0 }];
  await planificar(LUNES_MEDIODIA);
  await setJson('ult_in:+56900050001', { t: Date.now() }, 3600);
  const { p } = fakeProvider(true); // enviarTexto falla
  const rm = [...rms.values()][0];

  let r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.reprogramados, 1);
  assert.equal(rm.intentos, 1);
  rm.programadoPara = LUNES_MEDIODIA; // vence de nuevo
  await despachar(p, LUNES_MEDIODIA);
  rm.programadoPara = LUNES_MEDIODIA;
  r = await despachar(p, LUNES_MEDIODIA);
  assert.equal(r.fallidos, 1);
  assert.equal(rm.estado, 'fallido');
  await kvDel('ult_in:+56900050001');
});
