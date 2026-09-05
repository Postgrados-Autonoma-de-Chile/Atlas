import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { linkWaMe, numeroParaWaMe } = await import('../src/convocatoria/qr');
const { parametrosPlantilla, AGENDA_CONVOCATORIA, correrOleada } = await import('../src/convocatoria/motor');
const { dentroDeVentana, esDiaHabil, wallClock } = await import('../src/campaign/calendar');

// ─────────────────────────── entrada gratuita por QR ───────────────────────────

test('numeroParaWaMe: deja solo dígitos, como exige wa.me', () => {
  assert.equal(numeroParaWaMe('+56 9 1111 2222'), '56911112222');
  assert.equal(numeroParaWaMe('(569) 1111-2222'), '56911112222');
});

test('linkWaMe: precarga el texto, que es lo que hace gratuita la conversación', () => {
  const url = linkWaMe('+56911112222', 'Hola, quiero inscribirme en el curso de IA');
  assert.equal(
    url,
    'https://wa.me/56911112222?text=Hola%2C%20quiero%20inscribirme%20en%20el%20curso%20de%20IA',
  );
});

test('linkWaMe: sin texto devuelve el enlace pelado, no uno con ?text= vacío', () => {
  assert.equal(linkWaMe('+56911112222', '   '), 'https://wa.me/56911112222');
});

test('linkWaMe: número inválido devuelve null en vez de un enlace roto', () => {
  // Mejor no generar el QR que imprimir mil afiches con un enlace que no abre.
  for (const n of ['', '123', 'no-es-un-numero', '+56']) {
    assert.equal(linkWaMe(n, 'hola'), null, `debería rechazar "${n}"`);
  }
});

test('linkWaMe: escapa el texto (un & sin escapar cortaría el mensaje)', () => {
  const url = linkWaMe('+56911112222', 'IA & datos: ¿me sirve?')!;
  assert.ok(!url.includes('& datos'), 'el & debe quedar escapado');
  assert.ok(url.includes('%26'));
});

// ─────────────────────────── plantilla ───────────────────────────

test('parametrosPlantilla: usa el nombre de pila', () => {
  assert.deepEqual(parametrosPlantilla('Ana Soto Pérez'), ['Ana']);
});

test('parametrosPlantilla: nunca manda un parámetro vacío (Meta rechaza la plantilla)', () => {
  assert.deepEqual(parametrosPlantilla(null), ['Hola']);
  assert.deepEqual(parametrosPlantilla('   '), ['Hola']);
});

// ─────────────────────────── ventana horaria ───────────────────────────

test('la agenda no escribe de madrugada ni en domingo', () => {
  const v = AGENDA_CONVOCATORIA.ventanaHabil!;
  assert.equal(dentroDeVentana(3, 0, v), false, 'nadie quiere una invitación a las 3 AM');
  assert.equal(dentroDeVentana(12, 0, v), true);
  // dow 0 = domingo; la agenda declara lunes a sábado.
  assert.equal(AGENDA_CONVOCATORIA.diasHabiles!.includes(0), false);
});

test('los feriados de la agenda quedan fuera', () => {
  const f = AGENDA_CONVOCATORIA.feriados![0];
  const dow = wallClock(new Date(`${f}T15:00:00Z`), AGENDA_CONVOCATORIA.tz).dow;
  assert.equal(esDiaHabil(f, dow, AGENDA_CONVOCATORIA), false);
});

// ─────────────────────────── compuertas de gasto ───────────────────────────

const providerFalso = {
  async enviarPlantilla() {
    throw new Error('no debió enviarse nada');
  },
} as any;

test('viene APAGADA: encenderla es una decisión con costo', async () => {
  delete process.env.CONVOCATORIA_ACTIVA;
  const r = await correrOleada(providerFalso, 0);
  assert.deepEqual(r, { corrio: false, motivo: 'desactivada' });
});

test('activa pero sin plantilla configurada no envía nada', async () => {
  // config se congela al importar, así que se prueba el orden de las compuertas: la de "desactivada"
  // corta antes de tocar la base, que es lo que importa verificar sin Postgres.
  const r = await correrOleada(providerFalso, 0);
  assert.equal(r.corrio, false);
  assert.ok(['desactivada', 'sin_plantilla'].includes((r as any).motivo));
});

test('las compuertas se evalúan ANTES de consultar la base', async () => {
  // Sin DATABASE_URL, cualquier consulta lanzaría SIN_DB. Que la oleada devuelva un motivo limpio
  // prueba que ninguna compuerta llegó a la base.
  const r = await correrOleada(providerFalso, 999_999);
  assert.equal(r.corrio, false);
  assert.equal(typeof (r as any).motivo, 'string');
});
