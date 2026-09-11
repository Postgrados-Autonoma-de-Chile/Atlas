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

let porHora: any[] = [
  { hora: '09', turnos: 4, eventos: 11 },
  { hora: '10', turnos: 0, eventos: 0 },
  { hora: '11', turnos: 20, eventos: 60 },
];
let recientes: any[] = [
  { tipo: 'certificado_emitido', ts: new Date(Date.now() - 120_000) },
  { tipo: 'leccion_entregada', ts: new Date(Date.now() - 3_600_000) },
  { tipo: 'evento_que_no_existia', ts: new Date(Date.now() - 7_200_000) },
];
let cursos: any[] = [
  { codigo: 'NIVEL-1', nombre: 'Nivel Inicial', estado: 'activo', duracion_min: 55, modulos: 3,
    lecciones: 8, inscritas: 60, completadas: 20, minutos: 31, avance_pct: 42 },
  { codigo: 'NIVEL-0', nombre: 'Versión anterior', estado: 'archivado', duracion_min: 40, modulos: 2,
    lecciones: 6, inscritas: 9, completadas: 1, minutos: 12, avance_pct: 17 },
];
let modulos: any[] = [
  { curso: 'Nivel Inicial', orden: 1, nombre: 'Qué es la IA', lecciones: 3, entregadas: 30, completadas: 20 },
];

function responder(sql: string) {
  sqls.push(sql);
  if (/AS registradas/.test(sql)) return { rows: [embudo] };
  if (/GROUP BY completadas/.test(sql)) return { rows: avance };
  if (/FROM person WHERE created_at/.test(sql)) return { rows: altas };
  if (/AS hora/.test(sql)) return { rows: porHora };
  if (/percentile_disc/.test(sql)) {
    return { rows: [{ muestras: 218, mediana: '2400', p90: '9100' }] };
  }
  if (/GROUP BY 1 ORDER BY 2 DESC/.test(sql)) return { rows: [{ tipo: 'turn', n: 5 }] };
  if (/ORDER BY ts DESC LIMIT/.test(sql)) return { rows: recientes };
  if (/AS registro,/.test(sql)) {
    return { rows: [{ registro: 3, cuestionario: 2, inscripcion: 2, entregada: 9, completada: 6,
                      evaluacion: 4, certificado: 1, recordatorio: 12, consulta: 7 }] };
  }
  if (/FROM course c/.test(sql) && /AS modulos/.test(sql)) return { rows: cursos };
  if (/FROM module m/.test(sql)) return { rows: modulos };
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

const { resumenDireccion, pulsoAgente, catalogoPanel } = await import('../src/store/panel');
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

// ── Pulso del agente y catálogo: las métricas e interacciones del dashboard ──

const traerPulso = async () => { sqls = []; const p = await pulsoAgente(); assert.ok(p); return p!; };
const traerCatalogo = async () => { sqls = []; const c = await catalogoPanel(); assert.ok(c); return c!; };

test('el feed NO consulta el dialog_id: es el teléfono de la persona', async () => {
  // Esta vista existe para poder proyectarse en una reunión. Un feed que dijera "+56 9 …" la
  // convertiría en la misma pantalla que la de cohorte, que es la que NO se puede mostrar.
  await traerPulso();
  for (const q of sqls) assert.doesNotMatch(q, /dialog_id/, 'ni siquiera se selecciona');
  const p = await pulsoAgente();
  assert.ok(p!.recientes.every((e) => !('dialogId' in e) && !('waId' in e)));
});

test('un tipo de evento desconocido se muestra crudo, no se traga', async () => {
  // Si aparece un `type` nuevo y la tabla de etiquetas no lo tiene, la alternativa a mostrarlo feo
  // es que desaparezca del registro — que es peor.
  const r = await traer();
  const p = await pulsoAgente();
  const html = direccionHtml(r, 9.03, p, null);
  assert.match(html, /certificado emitido/, 'los conocidos se traducen');
  assert.match(html, /evento_que_no_existia/, 'y el desconocido igual aparece');
});

test('la latencia se informa como mediana y p90, nunca como promedio', async () => {
  // Un turno de certificación de 70 s arrastra la media y deja de describir lo que le pasa a la
  // mayoría. La consulta lo resuelve en Postgres, no en JS sobre todas las filas.
  await traerPulso();
  const q = sqls.find((s) => /percentile_disc/.test(s))!;
  assert.match(q, /percentile_disc\(0\.5\)/);
  assert.match(q, /percentile_disc\(0\.9\)/);
  assert.doesNotMatch(q, /avg\(/, 'nada de promedio');
  const r = await traer();
  const html = direccionHtml(r, 9.03, await pulsoAgente(), null);
  assert.match(html, /2,4 s/, 'mediana en segundos, con coma decimal');
  assert.match(html, /p90 9,1 s/);
});

test('las barras por hora apilan turnos dentro del total, sin partir el turno en dos', async () => {
  // El dashboard de referencia separa "mensajes del participante" de "respuestas del agente". Acá
  // un turno es las dos cosas a la vez y el desglose no está registrado, así que inventar el
  // reparto sería dibujar un dato que no existe. Se apila turnos dentro de eventos, que sí es
  // exacto: eventos INCLUYE los turnos.
  const r = await traer();
  const html = direccionHtml(r, 9.03, await pulsoAgente(), null);
  assert.match(html, /turnos con el tutor/);
  assert.match(html, /otros eventos del agente/);
  assert.doesNotMatch(html, /respuestas del agente/i, 'esa serie no existe en los datos');
  assert.match(html, /pico 11:00 · 60 eventos/);
});

test('las horas sin actividad se dibujan igual', async () => {
  await traerPulso();
  const q = sqls.find((s) => /AS hora/.test(s))!;
  assert.match(q, /generate_series/);
  assert.match(q, /AT TIME ZONE 'America\/Santiago'/, 'la hora es la de Chile');
  const r = await traer();
  const html = direccionHtml(r, 9.03, await pulsoAgente(), null);
  assert.match(html, />10</, 'la hora vacía conserva su lugar en el eje');
});

test('el ciclo de hoy cuenta eventos reales, etapa por etapa', async () => {
  const r = await traer();
  const html = direccionHtml(r, 9.03, await pulsoAgente(), null);
  assert.match(html, /sin intervención humana/);
  assert.match(html, /<b>9<\/b><span>microcápsulas entregadas/);
  assert.match(html, /<b>1<\/b><span>certificados/);
  assert.match(html, /envió 12 recordatorios/);
  assert.match(html, /material del curso 7 veces/);
});

test('el catálogo distingue el curso vigente de los archivados', async () => {
  const c = await traerCatalogo();
  assert.equal(c.cursos.length, 2);
  const r = await traer();
  const html = direccionHtml(r, 9.03, null, c);
  assert.match(html, /pastilla-ok">vigente/);
  assert.match(html, /curso-viejo/, 'el archivado se atenúa, no se esconde');
  assert.match(html, /42 % de avance promedio/);
});

test('el avance por módulo mide el cierre sobre lo entregado', async () => {
  const c = await traerCatalogo();
  // 20 completadas de 30 entregadas + 20 completadas = 40 %. Una entrega sin cierre es alguien
  // que la recibió y no volvió: ese es el número que importa.
  assert.equal(c.modulos[0].pct, 40);
});

test('si el pulso o el catálogo fallan, la vista se dibuja sin ese bloque', async () => {
  // Lo que no se puede leer no se rellena con nada. Media pantalla cierta es mejor que una
  // pantalla entera con un bloque inventado.
  const r = await traer();
  const html = direccionHtml(r, 9.03, null, null);
  assert.doesNotMatch(html, /sin intervención humana/);
  assert.doesNotMatch(html, /Cursos cargados/);
  assert.match(html, /Del registro al certificado/, 'el embudo sigue ahí');
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('la vista completa sigue sin un solo dato personal', async () => {
  const r = await traer();
  const html = direccionHtml(r, 9.03, await pulsoAgente(), await catalogoPanel());
  assert.doesNotMatch(html, /telefono|teléfono|wa_id|\+56|email|correo|rut/i);
});
