import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Vista de dirección: el programa visto por quien responde por él.
//
// POR QUÉ EXISTE: el panel de cohorte responde "a quién le escribo"; esta vista responde "esto
// funciona o no". Son lecturas distintas y por eso es una pantalla aparte, no una pestaña más de
// la misma tabla.
//
// Lo que estas pruebas cuidan es que los números no se hagan generosos solos. Un embudo miente de
// dos maneras conocidas: dejando fuera del denominador a quien se cayó —la tasa sube justo cuando
// el programa empeora— y dibujando un eje sin los días vacíos, que se leen como días que no
// existieron. Y una tercera, específica de acá: esta es la única vista del panel que se proyecta en
// una reunión, así que no puede llevar un solo dato personal.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let sqls: string[] = [];
let embudo: any = {
  registradas: 100, con_cuestionario: 80, inscritas: 60, cursando: 25,
  completaron: 20, certificadas: 18, certificadas_previas: 2, total_micro: 8,
};
let avance: any[] = [{ completadas: 0, personas: 30 }, { completadas: 8, personas: 20 }];
let altas: any[] = [{ dia: '2026-09-10', n: 3 }, { dia: '2026-09-11', n: 0 }];

function responder(sql: string) {
  sqls.push(sql);
  if (/AS registradas/.test(sql)) return { rows: [embudo] };
  if (/GROUP BY completadas/.test(sql)) return { rows: avance };
  if (/generate_series/.test(sql)) return { rows: altas };
  if (/AS turnos/.test(sql)) return { rows: [{ turnos: 1200, alertas: 2 }] };
  if (/vence_en BETWEEN/.test(sql)) return { rows: [{ n: 7 }] };
  throw new Error('consulta no prevista: ' + sql.replace(/\s+/g, ' ').slice(0, 70));
}

// La caché de 2 minutos se desactiva acá a propósito: con ella, la segunda prueba leería el
// resultado de la primera y ninguna estaría mirando una consulta de verdad. `mock.module` reemplaza
// el módulo COMPLETO, así que hay que declarar todo lo que panel.ts importa de kv.
let guardado: Record<string, unknown> = {};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getJson: async () => null,
    setJson: async (k: string, v: unknown) => { guardado[k] = v; },
  },
});

mock.module('../src/store/db.ts', {
  namedExports: {
    dbEnabled: () => true,
    getPool: () => ({ query: async (sql: string) => responder(sql) }),
  },
});

const { resumenDireccion } = await import('../src/store/panel');
const { direccionHtml } = await import('../src/obs/panelHtml');

const sqlCon = (re: RegExp) => sqls.find((s) => re.test(s));
const traer = async () => {
  sqls = [];
  const r = await resumenDireccion();
  assert.ok(r);
  return r!;
};

test('el embudo cuenta las inscripciones completas, no solo las vivas', async () => {
  // Si el peldaño "se inscribieron" contara solo las activas, los cupos vencidos desaparecerían
  // del embudo: el programa se vería mejor por haber perdido gente.
  const r = await traer();
  assert.equal(r.inscritas, 60);
  assert.equal(r.cursando, 25, 'cursando sigue existiendo, pero como foto del presente');
  const q = sqlCon(/AS inscritas/)!;
  assert.doesNotMatch(q.split('AS inscritas')[0].split('AS con_cuestionario')[1], /estado='activa'/);
});

test('la tasa de finalización se calcula sobre todos los que se inscribieron', async () => {
  const r = await traer();
  const html = direccionHtml(r, 9.03);
  // 20 de 60 = 33 %. Sobre cursando+completaron (25+20) daría 44 %, que es la cifra cómoda.
  assert.match(html, /33 %/);
  assert.doesNotMatch(html, /44 %/);
});

test('el eje de días incluye los días sin altas', async () => {
  await traer();
  const q = sqlCon(/generate_series/)!;
  assert.match(q, /generate_series\(/);
  assert.match(q, /LEFT JOIN/, 'los días vienen primero y las altas se les pegan, no al revés');
  assert.match(q, /COALESCE\(c\.n, 0\)/);
});

test('el día se corta en hora de Chile, no en UTC', async () => {
  // Un alta de las 21:00 en Santiago es del día siguiente en UTC: sin esto el gráfico movería
  // casi todas las inscripciones de la tarde al día equivocado.
  await traer();
  const q = sqlCon(/generate_series/)!;
  assert.match(q, /AT TIME ZONE 'America\/Santiago'/);
  assert.doesNotMatch(q, /interval '24 hours'/, 'sumar 24 h rompería el corte en el cambio de hora');
});

test('la distribución de avance rellena los tramos vacíos', async () => {
  const r = await traer();
  assert.equal(r.avance.length, 9, 'de 0 a 8 microcápsulas');
  assert.deepEqual(r.avance.map((a) => a.personas), [30, 0, 0, 0, 0, 0, 0, 0, 20]);
});

test('la vista NO lleva ningún dato personal', async () => {
  // Es la única del panel que se puede proyectar en una reunión. Que siga siendo cierto.
  const r = await traer();
  const html = direccionHtml(r, 9.03);
  assert.doesNotMatch(html, /telefono|teléfono|wa_id|nombre|email|correo|rut/i);
  for (const q of sqls) {
    assert.doesNotMatch(q, /p\.nombre|p\.telefono|wa_id/, 'ni siquiera se consultan');
  }
});

test('el costo se calcula con el precio por turno recibido, no con uno escrito adentro', async () => {
  const r = await traer();
  assert.match(direccionHtml(r, 10), /CLP 12\.000/, '1200 turnos × 10');
  assert.match(direccionHtml(r, 20), /CLP 24\.000/);
});

test('sin certificados el costo por certificado no divide por cero', async () => {
  const r = await traer();
  const html = direccionHtml({ ...r, certificadas: 0 }, 9.03);
  assert.match(html, /aún sin emitir/);
  assert.doesNotMatch(html, /Infinity|NaN/);
});

test('las alertas de bienestar se muestran como pendiente, no como logro', async () => {
  const r = await traer();
  const html = direccionHtml(r, 9.03);
  assert.match(html, /al-roja/);
  assert.match(html, /sin seguimiento humano definido/);
});

test('sin alertas ni cupos por vencer no se dibuja la franja', async () => {
  const r = await traer();
  const html = direccionHtml({ ...r, alertasBienestar: 0, cuposPorVencer: 0 }, 9.03);
  assert.doesNotMatch(html, /class="alertas"/);
});

test('el embudo no mezcla cohortes: los certificados se acotan al curso vigente', async () => {
  // Sin acotar, el último peldaño puede superar al anterior —certificados de una versión archivada
  // del curso contra inscripciones de la actual— y el embudo deja de leerse como un embudo.
  const r = await traer();
  assert.equal(r.certificadas, 18);
  assert.equal(r.certificadasPrevias, 2, 'los anteriores se cuentan, pero aparte');
  const q = sqlCon(/AS certificadas,/)!;
  assert.match(q, /JOIN enrollment e ON e\.id = ct\.enrollment_id/, 'el certificado llega al curso por su inscripción');
  assert.match(q, /c\.estado='activo'\) AS certificadas/);
});

test('los certificados de cohortes anteriores se nombran, no se borran', async () => {
  const r = await traer();
  assert.match(direccionHtml(r, 9.03), /2 certificados de versiones anteriores/);
  assert.doesNotMatch(direccionHtml({ ...r, certificadasPrevias: 0 }, 9.03), /versiones anteriores/);
  assert.match(direccionHtml({ ...r, certificadasPrevias: 1 }, 9.03), /1 certificado de versiones/, 'singular');
});

test('el resultado se deja en caché: el panel no rehace cinco agregados por visita', async () => {
  await traer();
  assert.ok(guardado['panel:direccion'], 'se guarda bajo una clave estable');
});

test('con el programa en cero no se rompe ni inventa porcentajes', async () => {
  embudo = { registradas: 0, con_cuestionario: 0, inscritas: 0, cursando: 0, completaron: 0, certificadas: 0, certificadas_previas: 0, total_micro: 8 };
  avance = [];
  altas = [];
  const r = await traer();
  const html = direccionHtml(r, 9.03);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(html, /0 %/);
});

test('las barras pintan con style, no con el atributo fill', async () => {
  // `fill` es un atributo de presentación y ahí `var()` no sustituye de forma confiable: la barra
  // se dibujaría negra —invisible sobre el fondo oscuro de Nocturne— sin ningún error. En `style`
  // sí sustituye. Se descubrió al aplicar el sistema, después de haber estado así en producción.
  const r = await traer();
  const html = direccionHtml(r, 9.03);
  assert.match(html, /<rect [^>]*style="fill:var\(--/);
  assert.doesNotMatch(html, /<rect [^>]*fill="var\(/, 'nunca var() en el atributo');
});
