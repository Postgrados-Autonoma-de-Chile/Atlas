import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Panel operativo de la cohorte. Lleva nombre y teléfono de personas reales, así que las pruebas
// cuidan dos cosas distintas:
//   · que los números que muestra sean los que la base tiene, y
//   · que NO muestre lo que no debe: el correo y el RUT van cifrados y el panel no los consulta.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const HACE = (dias: number) => new Date(Date.now() - dias * 86_400_000);

let filas: any[] = [];
let sqlVisto = '';

mock.module('../src/store/db.ts', {
  namedExports: {
    dbEnabled: () => true,
    dbInsertAudit: async () => {},
    getPool: () => ({ query: async (sql: string) => ((sqlVisto = sql), { rows: filas, rowCount: filas.length }) }),
  },
});

const { panelCohorte } = await import('../src/store/panel');
const { panelCohorteHtml, panelAccesoHtml } = await import('../src/obs/panelHtml');

const FILA = {
  id: 'p1', nombre: 'Rodrigo', apellido: 'Palma', created_at: HACE(6),
  caracterizacion_completada_en: HACE(5), wa_id: '+56912345678',
  turnos: 14, eventos: 31, alertas: 0, ultimo: HACE(1),
  curso: 'Nivel Inicial: Alfabetización ciudadana en Inteligencia Artificial',
  curso_estado: 'activo', inscripcion: 'activa', total: 8, completadas: 3, folio: null,
};

test('la consulta NO toca el correo ni el RUT cifrados', async () => {
  // El panel es para seguimiento operativo. Descifrar PII que no necesita sería ampliar el daño de
  // una filtración sin ninguna ganancia.
  filas = [FILA];
  await panelCohorte(90);
  assert.doesNotMatch(sqlVisto, /email_enc|rut_enc/, 'ni siquiera se seleccionan');
});

test('una fila trae los datos que se pidieron: nombre, teléfono, mensajes y fechas', async () => {
  filas = [FILA];
  const r = await panelCohorte(90);
  assert.equal(r!.filas.length, 1);
  const f = r!.filas[0];
  assert.equal(f.nombre, 'Rodrigo Palma');
  assert.equal(f.waId, '+56912345678');
  assert.equal(f.turnos, 14);
  assert.equal(f.eventos, 31);
  assert.equal(f.completadas, 3);
  assert.equal(f.totalLecciones, 8);
  assert.ok(f.registradoEn instanceof Date);
  assert.ok(f.ultimoEn instanceof Date);
  assert.equal(f.cursoArchivado, false);
});

test('quien quedó en la versión anterior se marca como tal', async () => {
  filas = [{ ...FILA, curso: 'IA en la vida cotidiana', curso_estado: 'archivado', completadas: 3, total: 9 }];
  const r = await panelCohorte(90);
  assert.equal(r!.filas[0].cursoArchivado, true);
  const html = panelCohorteHtml(r!);
  assert.match(html, /versión anterior · 3\/9/);
});

test('sin actividad registrada, el panel no inventa una fecha', async () => {
  filas = [{ ...FILA, turnos: 0, eventos: 0, ultimo: null }];
  const r = await panelCohorte(90);
  assert.equal(r!.filas[0].ultimoEn, null);
  const html = panelCohorteHtml(r!);
  assert.match(html, /sin actividad/);
  assert.match(html, />—</, 'la fecha vacía se muestra como raya, no como 1970');
});

test('el HTML escapa el nombre: viene de lo que la persona escribió por WhatsApp', async () => {
  // El nombre lo tipea el estudiante en el registro. Es texto no confiable en una página HTML.
  filas = [{ ...FILA, nombre: '<script>alert(1)</script>', apellido: null }];
  const r = await panelCohorte(90);
  const html = panelCohorteHtml(r!);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('los totales de arriba cuadran con las filas', async () => {
  filas = [
    { ...FILA, id: 'a', ultimo: HACE(1), completadas: 3, folio: null },
    { ...FILA, id: 'b', ultimo: HACE(30), completadas: 0, folio: null },
    { ...FILA, id: 'c', ultimo: HACE(2), completadas: 9, folio: 'ATLAS-2026-0002' },
  ];
  const r = await panelCohorte(90);
  const html = panelCohorteHtml(r!);
  assert.match(html, /<b>3<\/b><span>registradas/);
  assert.match(html, /<b>2<\/b><span>activas \(7 días\)/, 'la de hace 30 días no cuenta como activa');
  assert.match(html, /<b>2<\/b><span>con avance/);
  assert.match(html, /<b>1<\/b><span>certificadas/);
});

test('la página avisa qué contiene y que la auditoría se purga', async () => {
  filas = [FILA];
  const html = panelCohorteHtml((await panelCohorte(90))!);
  assert.match(html, /noindex/, 'no se indexa: tiene nombres y teléfonos');
  assert.match(html, /conserva 90 días/, 'un cero puede ser historial purgado, no inactividad');
  assert.match(html, /No compartir/);
  assert.doesNotMatch(html, /https?:\/\//, 'sin recursos remotos: nada viaja a un tercero');
});

test('la contención por riesgo vital se marca en la fila y en un aviso arriba', async () => {
  // El evento vivía en audit_log, que nadie lee. Si el programa contempla seguimiento humano,
  // esta es la fila que lo requiere; sin marcarla, la detección no sirve de nada.
  filas = [{ ...FILA, alertas: 2 }, { ...FILA, id: 'p2', alertas: 0 }];
  const r = await panelCohorte(90);
  assert.equal(r!.filas[0].alertasBienestar, 2);
  const html = panelCohorteHtml(r!);
  assert.match(html, /contención ×2/);
  assert.match(html, /<b style="color:#b3261e">1<\/b><span>con contención/, 'una sola persona, no dos');
  assert.match(html, /4141/, 'el aviso recuerda qué se le entregó');
  assert.match(html, /NO se guarda/, 'lo que escribió no queda en ninguna parte');
  assert.match(html, /no tiene seguimiento humano/,
    'la marca no puede insinuar un proceso que el programa declaró que no existe');
  assert.match(html, /nadie es notificado/);
});

test('sin contenciones, el panel no muestra el bloque rojo', async () => {
  filas = [FILA];
  const html = panelCohorteHtml((await panelCohorte(90))!);
  assert.doesNotMatch(html, /contención/);
});

// ── Página de acceso ───────────────────────────────────────────────────────

test('la página de acceso no lleva un solo dato de nadie', async () => {
  // Es pública: si alguien la abre sin token, no puede ver nada. Por eso no consulta la base.
  const html = panelAccesoHtml(60);
  assert.doesNotMatch(html, /\+569/, 'ningún teléfono');
  assert.doesNotMatch(html, /Rodrigo|Palma/, 'ningún nombre');
  assert.match(html, /type="password"/, 'el token no se muestra al tipearlo');
  assert.match(html, /noindex/);
});

test('el token viaja por header y nunca por la URL', async () => {
  // La salida fácil —aceptarlo por query string— es la que este proyecto ya descartó: queda en los
  // logs de los proxies, en el historial y en el Referer.
  const html = panelAccesoHtml(60);
  assert.match(html, /'x-dashboard-token':tk/);
  assert.doesNotMatch(html, /[?&]token=/, 'nunca en la query string');
  assert.match(html, /sessionStorage/, 'muere al cerrar la pestaña');
  assert.doesNotMatch(html, /localStorage/, 'no sobrevive al cierre del navegador');
});

test('un 401 vuelve a pedir el token en vez de dejar la vista colgada', async () => {
  const html = panelAccesoHtml(60);
  assert.match(html, /r\.status===401/);
  assert.match(html, /no es válido/);
  assert.match(html, /removeItem/, 'y descarta el token guardado');
});

test('el refresco automático es configurable y va en la página', async () => {
  assert.match(panelAccesoHtml(30), /REFRESCO=30\*1000/);
  assert.match(panelAccesoHtml(120), /REFRESCO=120\*1000/);
});

test('el modo fragmento no trae envoltorio de documento, y el completo sí', async () => {
  // Un solo render para los dos: mantener dos versiones de la tabla garantiza que se separen.
  filas = [FILA];
  const r = (await panelCohorte(90))!;
  const frag = panelCohorteHtml(r, true);
  assert.doesNotMatch(frag, /<!doctype|<style>/i);
  assert.match(frag, /Rodrigo Palma/, 'pero sí el contenido');
  const completo = panelCohorteHtml(r);
  assert.match(completo, /<!doctype/i);
  assert.match(completo, /<style>/);
});
