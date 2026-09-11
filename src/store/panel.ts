import { getPool } from './db';
import { getJson, setJson } from './kv';
import { log } from '../log';

// Panel operativo de la cohorte: quién está, cuánto conversó y cuándo.
//
// Es la vista que el equipo del programa necesita para hacer seguimiento, y por eso lleva datos
// personales: nombre y teléfono. Vive detrás de requireDashboardToken —el mismo guard de /metrics,
// cuyo comentario ya anticipaba "los futuros paneles de tutoría"— y no se expone en ninguna ruta
// pública.
//
// Nombre y apellido están en claro en `person` (solo el correo y el RUT van cifrados), y el
// teléfono es `person_identity.valor_lookup` del tipo wa_id. No hace falta descifrar nada: el panel
// NO toca email_enc ni rut_enc, así que el dato más sensible de cada persona no pasa por acá.

export type FilaPanel = {
  personId: string;
  nombre: string;
  waId: string;
  registradoEn: Date;
  /** Turnos conversacionales con el tutor (audit_log type='turn'). */
  turnos: number;
  /** Todos los eventos registrados de esa conversación: registro, cuestionario, práctica, etc. */
  eventos: number;
  ultimoEn: Date | null;
  /** Veces que se activó la contención por señal de riesgo vital. Para seguimiento del equipo. */
  alertasBienestar: number;
  curso: string | null;
  cursoArchivado: boolean;
  inscripcion: string | null;
  completadas: number;
  totalLecciones: number;
  caracterizacionCompleta: boolean;
  folio: string | null;
};

export type ResumenPanel = {
  filas: FilaPanel[];
  /** Días de historial que conserva audit_log (barrido de retención). */
  retencionDias: number;
  generadoEn: Date;
};

/**
 * Una fila por persona registrada, ordenada por última actividad.
 *
 * Los conteos salen de audit_log, que retiene 90 días: para el piloto cubre todo el historial, pero
 * el panel lo dice en pantalla para que nadie lea un cero como "nunca escribió".
 */
export async function panelCohorte(retencionDias: number): Promise<ResumenPanel | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `WITH act AS (
         SELECT dialog_id,
                count(*)::int AS eventos,
                count(*) FILTER (WHERE type = 'turn')::int AS turnos,
                count(*) FILTER (WHERE type = 'alerta_bienestar')::int AS alertas,
                max(ts) AS ultimo
           FROM audit_log
          WHERE dialog_id IS NOT NULL
          GROUP BY dialog_id
       ), ins AS (
         SELECT DISTINCT ON (e.person_id)
                e.person_id, e.id AS enrollment_id, e.estado, c.nombre AS curso, c.estado AS curso_estado,
                (SELECT count(*)::int FROM lesson l JOIN module m ON m.id = l.module_id
                  WHERE m.course_id = c.id) AS total
           FROM enrollment e JOIN course c ON c.id = e.course_id
          ORDER BY e.person_id, (c.estado = 'activo') DESC, e.iniciado_en DESC
       )
       SELECT p.id, p.nombre, p.apellido, p.created_at,
              p.caracterizacion_completada_en,
              i.valor_lookup AS wa_id,
              COALESCE(a.turnos, 0) AS turnos,
              COALESCE(a.eventos, 0) AS eventos,
              COALESCE(a.alertas, 0) AS alertas,
              a.ultimo,
              ins.curso, ins.curso_estado, ins.estado AS inscripcion, ins.total,
              (SELECT count(*)::int FROM lesson_progress lp
                WHERE lp.enrollment_id = ins.enrollment_id AND lp.estado = 'completada') AS completadas,
              (SELECT ct.folio FROM certificate ct
                WHERE ct.person_id = p.id AND ct.folio IS NOT NULL ORDER BY ct.folio LIMIT 1) AS folio
         FROM person p
         JOIN person_identity i ON i.person_id = p.id AND i.tipo = 'wa_id'
         LEFT JOIN act a ON a.dialog_id = i.valor_lookup
         LEFT JOIN ins ON ins.person_id = p.id
        ORDER BY a.ultimo DESC NULLS LAST, p.created_at DESC`,
    );
    return {
      retencionDias,
      generadoEn: new Date(),
      filas: r.rows.map((f: any) => ({
        personId: f.id,
        nombre: [f.nombre, f.apellido].filter(Boolean).join(' ') || '(sin nombre)',
        waId: f.wa_id,
        registradoEn: f.created_at,
        turnos: f.turnos,
        eventos: f.eventos,
        ultimoEn: f.ultimo ?? null,
        alertasBienestar: f.alertas ?? 0,
        curso: f.curso ?? null,
        cursoArchivado: f.curso_estado ? f.curso_estado !== 'activo' : false,
        inscripcion: f.inscripcion ?? null,
        completadas: f.completadas ?? 0,
        totalLecciones: f.total ?? 0,
        caracterizacionCompleta: Boolean(f.caracterizacion_completada_en),
        folio: f.folio ?? null,
      })),
    };
  } catch (e) {
    log.warn('panel: panelCohorte falló', { err: String(e) });
    return null;
  }
}

// ── Caracterización ─────────────────────────────────────────────────────────
//
// Dos vistas con costos muy distintos a escala de programa, y por eso se resuelven distinto.
//
// El AGREGADO es para lo que existe el cuestionario —«orientar la oferta formativa»— y con 200.000
// personas recorre 2,2 millones de respuestas. Es una consulta cara para repetirla en cada carga de
// pantalla, pero su resultado cambia lentamente: se cachea en Redis unos minutos.
//
// El DETALLE se pagina por KEYSET y nunca con OFFSET. Un `OFFSET 100000` obliga a Postgres a leer y
// descartar cien mil filas antes de devolver la página, y el costo crece con el número de página;
// el keyset lee siempre solo las que se van a mostrar. Y las respuestas se traen únicamente de las
// personas de la página, con `WHERE person_id = ANY(...)`, así que ninguna consulta escala con el
// tamaño del padrón.

export type OpcionAgregada = { texto: string; n: number; pct: number };
export type PreguntaAgregada = {
  orden: number; codigo: string; enunciado: string; respondieron: number; opciones: OpcionAgregada[];
};

export type PersonaCaracterizada = {
  personId: string;
  nombre: string;
  waId: string;
  completadaEn: Date;
  /** Respuesta por código de pregunta ('edad' → '25–34 años'). */
  respuestas: Record<string, string>;
};

export type PaginaCaracterizacion = {
  filas: PersonaCaracterizada[];
  /** Cursor de la página siguiente, o null si esta era la última. */
  siguiente: string | null;
  columnas: { codigo: string; enunciado: string }[];
};

const CACHE_AGREGADO = 'panel:caracterizacion:agregado';
const CACHE_TTL = 300; // 5 minutos: el agregado cambia lento y la consulta es la cara

/** Distribución de respuestas por pregunta. Cacheada: es la consulta que recorre toda la tabla. */
export async function caracterizacionAgregada(): Promise<PreguntaAgregada[] | null> {
  const cacheado = await getJson<PreguntaAgregada[]>(CACHE_AGREGADO);
  if (cacheado) return cacheado;

  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT q.orden, q.codigo, q.enunciado, o.orden AS op_orden, o.texto,
              count(a.id)::int AS n
         FROM survey_question q
         JOIN survey_option o ON o.question_id = q.id
         LEFT JOIN survey_answer a ON a.option_id = o.id
        WHERE q.estado = 'activo'
        GROUP BY q.orden, q.codigo, q.enunciado, o.orden, o.texto
        ORDER BY q.orden, o.orden`,
    );
    const porPregunta = new Map<number, PreguntaAgregada>();
    for (const f of r.rows) {
      let p = porPregunta.get(f.orden);
      if (!p) {
        p = { orden: f.orden, codigo: f.codigo, enunciado: f.enunciado, respondieron: 0, opciones: [] };
        porPregunta.set(f.orden, p);
      }
      p.opciones.push({ texto: f.texto, n: f.n, pct: 0 });
      p.respondieron += f.n;
    }
    const salida = [...porPregunta.values()].map((p) => ({
      ...p,
      // Redondeado a un decimal: nada necesita más precisión, y así el ruido de coma flotante
      // (55,00000000000001) no viaja al caché ni al HTML.
      opciones: p.opciones.map((o) => ({
        ...o, pct: p.respondieron ? Math.round((o.n / p.respondieron) * 1000) / 10 : 0,
      })),
    }));
    await setJson(CACHE_AGREGADO, salida, CACHE_TTL);
    return salida;
  } catch (e) {
    log.warn('panel: caracterizacionAgregada falló', { err: String(e) });
    return null;
  }
}

const TOPE_PAGINA = 100;

/** Cursor opaco: fecha ISO y uuid, que es el orden exacto del índice parcial de person. */
function partirCursor(cursor: string | null): { ts: string; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf('|');
  if (i < 0) return null;
  const ts = cursor.slice(0, i);
  const id = cursor.slice(i + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(Date.parse(ts))) return null;
  return { ts, id };
}

/** Una página de personas con su cuestionario, ordenada por fecha de término descendente. */
export async function caracterizacionPagina(
  cursor: string | null, limite = 50,
): Promise<PaginaCaracterizacion | null> {
  const pool = getPool();
  if (!pool) return null;
  const n = Math.min(Math.max(1, Math.trunc(limite)), TOPE_PAGINA);
  const desde = partirCursor(cursor);
  try {
    const cols = await pool.query(
      `SELECT codigo, enunciado FROM survey_question WHERE estado='activo' ORDER BY orden`,
    );

    // Se piden n+1 para saber si hay página siguiente sin contar el total: un COUNT(*) sobre el
    // padrón completo costaría más que la página misma.
    const gente = await pool.query(
      `SELECT p.id, p.nombre, p.apellido, p.caracterizacion_completada_en AS completada,
              i.valor_lookup AS wa_id
         FROM person p
         JOIN person_identity i ON i.person_id = p.id AND i.tipo = 'wa_id'
        WHERE p.caracterizacion_completada_en IS NOT NULL
          ${desde ? 'AND (p.caracterizacion_completada_en, p.id) < ($2::timestamptz, $3::uuid)' : ''}
        ORDER BY p.caracterizacion_completada_en DESC, p.id DESC
        LIMIT $1`,
      desde ? [n + 1, desde.ts, desde.id] : [n + 1],
    );

    const hayMas = gente.rows.length > n;
    const pagina = hayMas ? gente.rows.slice(0, n) : gente.rows;
    if (!pagina.length) {
      return { filas: [], siguiente: null, columnas: cols.rows };
    }

    // Solo las respuestas de esta página: acotado por diseño, no por suerte.
    const ids = pagina.map((f: any) => f.id);
    const resp = await pool.query(
      `SELECT a.person_id, q.codigo, o.texto
         FROM survey_answer a
         JOIN survey_question q ON q.id = a.question_id
         JOIN survey_option o ON o.id = a.option_id
        WHERE a.person_id = ANY($1::uuid[])`,
      [ids],
    );
    const porPersona = new Map<string, Record<string, string>>();
    for (const f of resp.rows) {
      const m = porPersona.get(f.person_id) ?? {};
      m[f.codigo] = f.texto;
      porPersona.set(f.person_id, m);
    }

    const ultima = pagina[pagina.length - 1];
    return {
      filas: pagina.map((f: any) => ({
        personId: f.id,
        nombre: [f.nombre, f.apellido].filter(Boolean).join(' ') || '(sin nombre)',
        waId: f.wa_id,
        completadaEn: f.completada,
        respuestas: porPersona.get(f.id) ?? {},
      })),
      siguiente: hayMas ? `${new Date(ultima.completada).toISOString()}|${ultima.id}` : null,
      columnas: cols.rows,
    };
  } catch (e) {
    log.warn('panel: caracterizacionPagina falló', { err: String(e) });
    return null;
  }
}

// ── Vista de dirección ──────────────────────────────────────────────────────
//
// Otro lector, otra pregunta. El operador necesita saber a quién escribirle; quien dirige el
// programa necesita saber si el programa funciona: cuánta gente entra, dónde se cae, cuántos
// certificados salen y cuánto cuesta cada uno.
//
// Todo son agregados, así que no hay datos personales en esta vista — y por eso es la que se puede
// mostrar en una reunión sin exponer a nadie.

export type ResumenDireccion = {
  registradas: number;
  conCuestionario: number;
  /** Personas que alguna vez se inscribieron, en cualquier estado. Es el peldaño del embudo. */
  inscritas: number;
  /** Inscripciones vivas hoy. NO es un peldaño del embudo: es una foto del presente. */
  cursando: number;
  completaron: number;
  certificadas: number;
  /** Certificados de versiones anteriores del curso. Fuera del embudo, pero no borrados. */
  certificadasPrevias: number;
  /** Personas por cantidad de microcápsulas completadas, de 0 al total del curso. */
  avance: { completadas: number; personas: number }[];
  totalMicrocapsulas: number;
  /** Altas por día, del más antiguo al más reciente. */
  registrosPorDia: { dia: string; n: number }[];
  turnos: number;
  /** Contenciones por señal de riesgo vital. Un número, sin identificar a nadie. */
  alertasBienestar: number;
  /** Cupos que vencen dentro de los próximos 7 días. */
  cuposPorVencer: number;
  generadoEn: Date;
};

const CACHE_DIRECCION = 'panel:direccion';
const CACHE_DIRECCION_TTL = 120;

export async function resumenDireccion(): Promise<ResumenDireccion | null> {
  const cacheado = await getJson<ResumenDireccion>(CACHE_DIRECCION);
  if (cacheado) return { ...cacheado, generadoEn: new Date(cacheado.generadoEn) };

  const pool = getPool();
  if (!pool) return null;
  try {
    const [embudo, avance, altas, actividad, cupos] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM person) AS registradas,
           (SELECT count(*)::int FROM person WHERE caracterizacion_completada_en IS NOT NULL) AS con_cuestionario,
           (SELECT count(*)::int FROM enrollment e JOIN course c ON c.id=e.course_id
             WHERE c.estado='activo') AS inscritas,
           (SELECT count(*)::int FROM enrollment e JOIN course c ON c.id=e.course_id
             WHERE c.estado='activo' AND e.estado='activa') AS cursando,
           (SELECT count(*)::int FROM enrollment e JOIN course c ON c.id=e.course_id
             WHERE c.estado='activo' AND e.estado='completada') AS completaron,
           -- Acotado al curso vigente, como TODOS los peldaños: contar los certificados de
           -- cohortes anteriores acá produciría un embudo donde el último peldaño supera al
           -- anterior. Los previos se cuentan aparte para no hacerlos desaparecer.
           (SELECT count(*)::int FROM certificate ct
              JOIN enrollment e ON e.id = ct.enrollment_id
              JOIN course c ON c.id = e.course_id
             WHERE ct.folio IS NOT NULL AND c.estado='activo') AS certificadas,
           (SELECT count(*)::int FROM certificate ct
              JOIN enrollment e ON e.id = ct.enrollment_id
              JOIN course c ON c.id = e.course_id
             WHERE ct.folio IS NOT NULL AND c.estado<>'activo') AS certificadas_previas,
           (SELECT count(*)::int FROM lesson l JOIN module m ON m.id=l.module_id
             JOIN course c ON c.id=m.course_id WHERE c.estado='activo') AS total_micro`,
      ),
      pool.query(
        `SELECT completadas, count(*)::int AS personas FROM (
           SELECT e.id, count(*) FILTER (WHERE lp.estado='completada')::int AS completadas
             FROM enrollment e
             JOIN course c ON c.id = e.course_id AND c.estado='activo'
             LEFT JOIN lesson_progress lp ON lp.enrollment_id = e.id
            GROUP BY e.id
         ) x GROUP BY completadas ORDER BY completadas`,
      ),
      pool.query(
        // generate_series rellena los días sin altas: un hueco en el eje se leería como un día
        // que no existió. La fecha se trunca en hora de Chile —no en UTC— porque el eje lo mira
        // alguien que cuenta los días acá; y así el corte del día no se mueve con el horario de
        // verano, cosa que sí pasaría sumando intervalos de 24 horas.
        `SELECT to_char(s.d, 'YYYY-MM-DD') AS dia, COALESCE(c.n, 0)::int AS n
           FROM generate_series(
                  date_trunc('day', now() AT TIME ZONE 'America/Santiago') - interval '13 days',
                  date_trunc('day', now() AT TIME ZONE 'America/Santiago'),
                  interval '1 day') AS s(d)
           LEFT JOIN (
             SELECT date_trunc('day', created_at AT TIME ZONE 'America/Santiago') AS d,
                    count(*)::int AS n
               FROM person WHERE created_at > now() - interval '15 days'
              GROUP BY 1
           ) c ON c.d = s.d
          ORDER BY s.d`,
      ),
      pool.query(
        `SELECT
           count(*) FILTER (WHERE type='turn')::int AS turnos,
           count(*) FILTER (WHERE type='alerta_bienestar')::int AS alertas
           FROM audit_log`,
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM enrollment e JOIN course c ON c.id=e.course_id
          WHERE c.estado='activo' AND e.estado='activa'
            AND e.vence_en IS NOT NULL AND e.vence_en BETWEEN now() AND now() + interval '7 days'`,
      ),
    ]);

    const f = embudo.rows[0];
    const total = f.total_micro ?? 0;
    // La distribución se completa con los ceros: un hueco en el eje es tan informativo como una
    // barra, y sin rellenar se dibujaría un gráfico con tramos que no existen.
    const porAvance = new Map<number, number>(avance.rows.map((r: any) => [r.completadas, r.personas]));
    const salida: ResumenDireccion = {
      registradas: f.registradas, conCuestionario: f.con_cuestionario,
      inscritas: f.inscritas, cursando: f.cursando,
      completaron: f.completaron, certificadas: f.certificadas,
      certificadasPrevias: f.certificadas_previas ?? 0,
      totalMicrocapsulas: total,
      avance: Array.from({ length: total + 1 }, (_, i) => ({ completadas: i, personas: porAvance.get(i) ?? 0 })),
      registrosPorDia: altas.rows.map((r: any) => ({ dia: r.dia, n: r.n })),
      turnos: actividad.rows[0]?.turnos ?? 0,
      alertasBienestar: actividad.rows[0]?.alertas ?? 0,
      cuposPorVencer: cupos.rows[0]?.n ?? 0,
      generadoEn: new Date(),
    };
    await setJson(CACHE_DIRECCION, salida, CACHE_DIRECCION_TTL);
    return salida;
  } catch (e) {
    log.warn('panel: resumenDireccion falló', { err: String(e) });
    return null;
  }
}

/**
 * Pulso del agente: qué está haciendo ATLAS ahora mismo.
 *
 * Es la parte "viva" del panel, y por eso va aparte de `resumenDireccion`: el embudo se mueve en
 * semanas y se cachea 2 minutos, esto se mueve en minutos y se cachea 30 segundos. Mezclarlos
 * obligaría a elegir un solo TTL y uno de los dos quedaría mal servido.
 *
 * TODO sale de `audit_log`, que es el registro real de eventos del sistema — no hay una tabla de
 * métricas que alguien tenga que mantener en paralelo. Y NO se lee `dialog_id`: es el teléfono de
 * la persona, y esta vista existe precisamente para poder mostrarse sin exponer a nadie. El feed
 * dice qué pasó y cuándo, nunca a quién.
 */
export type PulsoAgente = {
  /** Interacciones por hora, últimas 14 h en hora de Chile. */
  porHora: { hora: string; turnos: number; eventos: number }[];
  /** Latencia de respuesta del tutor, sobre las últimas 24 h. */
  latencia: { medianaMs: number | null; p90Ms: number | null; muestras: number };
  /** Eventos por tipo en las últimas 24 h, del más frecuente al menos. */
  porTipo: { tipo: string; n: number }[];
  /** Los últimos eventos del agente. Sin identificar a nadie: tipo y hora. */
  recientes: { tipo: string; en: Date }[];
  /** El ciclo de hoy, etapa por etapa. Las etapas son eventos reales, no una narrativa. */
  ciclo: { clave: string; n: number }[];
  generadoEn: Date;
};

/**
 * Lo que NO entra al feed.
 *
 * 'turn' acompaña a cada interacción, y 'tool_call'/'tool_result' se disparan varias veces dentro
 * de una sola: los tres juntos taparían por completo lo que cuenta la historia —se entregó una
 * microcápsula, se emitió un certificado—, que es para lo que existe el feed. No es que sean
 * eventos menores; es que son de otra escala, y catorce filas se llenan con ellos antes de
 * mostrar nada del programa. Siguen contándose en el gráfico por hora, que sí los quiere.
 */
const FUERA_DEL_FEED = ['turn', 'tool_call', 'tool_result'];

const CACHE_PULSO = 'panel:pulso';
const CACHE_PULSO_TTL = 30;

export async function pulsoAgente(): Promise<PulsoAgente | null> {
  const cacheado = await getJson<PulsoAgente>(CACHE_PULSO);
  if (cacheado) {
    return {
      ...cacheado,
      recientes: cacheado.recientes.map((r) => ({ ...r, en: new Date(r.en) })),
      generadoEn: new Date(cacheado.generadoEn),
    };
  }

  const pool = getPool();
  if (!pool) return null;
  try {
    const [horas, latencia, tipos, recientes, ciclo] = await Promise.all([
      // Las horas vacías también son un dato: generate_series las rellena, porque un hueco en el
      // eje se leería como una hora que no existió. Truncado en hora de Chile.
      pool.query(
        `SELECT to_char(s.h, 'HH24') AS hora,
                COALESCE(a.turnos, 0)::int AS turnos, COALESCE(a.eventos, 0)::int AS eventos
           FROM generate_series(
                  date_trunc('hour', now() AT TIME ZONE 'America/Santiago') - interval '13 hours',
                  date_trunc('hour', now() AT TIME ZONE 'America/Santiago'),
                  interval '1 hour') AS s(h)
           LEFT JOIN (
             SELECT date_trunc('hour', ts AT TIME ZONE 'America/Santiago') AS h,
                    count(*) FILTER (WHERE type = 'turn')::int AS turnos,
                    count(*)::int AS eventos
               FROM audit_log WHERE ts > now() - interval '15 hours'
              GROUP BY 1
           ) a ON a.h = s.h
          ORDER BY s.h`,
      ),
      // La mediana y el p90, no el promedio: un turno de certificación de 70 s arrastra la media y
      // deja de describir lo que le pasa a la mayoría.
      pool.query(
        `SELECT count(*)::int AS muestras,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY (detail->>'responseMs')::bigint) AS mediana,
                percentile_disc(0.9) WITHIN GROUP (ORDER BY (detail->>'responseMs')::bigint) AS p90
           FROM audit_log
          WHERE type = 'turn' AND ts > now() - interval '24 hours'
            AND detail ? 'responseMs' AND (detail->>'responseMs') ~ '^[0-9]+$'`,
      ),
      pool.query(
        `SELECT type AS tipo, count(*)::int AS n FROM audit_log
          WHERE ts > now() - interval '24 hours' AND type <> ALL($1)
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`,
        [FUERA_DEL_FEED],
      ),
      pool.query(
        `SELECT type AS tipo, ts FROM audit_log
          WHERE type <> ALL($1) ORDER BY ts DESC LIMIT 14`,
        [FUERA_DEL_FEED],
      ),
      pool.query(
        `SELECT
           count(*) FILTER (WHERE type = 'registro_completo')::int AS registro,
           count(*) FILTER (WHERE type = 'caracterizacion_completada')::int AS cuestionario,
           count(*) FILTER (WHERE type IN ('inscripcion','inscripcion_reactivada'))::int AS inscripcion,
           count(*) FILTER (WHERE type = 'leccion_entregada')::int AS entregada,
           count(*) FILTER (WHERE type = 'leccion_completada')::int AS completada,
           count(*) FILTER (WHERE type = 'evaluacion_finalizada')::int AS evaluacion,
           count(*) FILTER (WHERE type = 'certificado_emitido')::int AS certificado,
           count(*) FILTER (WHERE type = 'recordatorio_enviado')::int AS recordatorio,
           count(*) FILTER (WHERE type = 'rag_busqueda')::int AS consulta
           FROM audit_log
          WHERE ts >= date_trunc('day', now() AT TIME ZONE 'America/Santiago')
                       AT TIME ZONE 'America/Santiago'`,
      ),
    ]);

    const l = latencia.rows[0] ?? {};
    const c = ciclo.rows[0] ?? {};
    const salida: PulsoAgente = {
      porHora: horas.rows.map((r: any) => ({ hora: r.hora, turnos: r.turnos, eventos: r.eventos })),
      latencia: {
        muestras: l.muestras ?? 0,
        medianaMs: l.mediana != null ? Number(l.mediana) : null,
        p90Ms: l.p90 != null ? Number(l.p90) : null,
      },
      porTipo: tipos.rows.map((r: any) => ({ tipo: r.tipo, n: r.n })),
      recientes: recientes.rows.map((r: any) => ({ tipo: r.tipo, en: new Date(r.ts) })),
      ciclo: [
        { clave: 'registro', n: c.registro ?? 0 },
        { clave: 'cuestionario', n: c.cuestionario ?? 0 },
        { clave: 'inscripcion', n: c.inscripcion ?? 0 },
        { clave: 'entregada', n: c.entregada ?? 0 },
        { clave: 'completada', n: c.completada ?? 0 },
        { clave: 'evaluacion', n: c.evaluacion ?? 0 },
        { clave: 'certificado', n: c.certificado ?? 0 },
        { clave: 'recordatorio', n: c.recordatorio ?? 0 },
        { clave: 'consulta', n: c.consulta ?? 0 },
      ],
      generadoEn: new Date(),
    };
    await setJson(CACHE_PULSO, salida, CACHE_PULSO_TTL);
    return salida;
  } catch (e) {
    log.warn('panel: pulsoAgente falló', { err: String(e) });
    return null;
  }
}

/**
 * El catálogo que el agente tiene cargado, y cómo avanza la gente por él.
 *
 * Son pocos cursos y pocos módulos, así que las subconsultas por curso no son un problema; lo que
 * las vuelve baratas de todos modos es la caché, porque esto cambia cuando se recarga el currículo
 * y no cuando alguien escribe por WhatsApp.
 */
export type CatalogoPanel = {
  cursos: {
    codigo: string; nombre: string; estado: string; modulos: number; lecciones: number;
    duracionMin: number; inscritas: number; completadas: number; avancePct: number;
    minutosPromedio: number;
  }[];
  modulos: {
    curso: string; orden: number; nombre: string; lecciones: number;
    entregadas: number; completadas: number; pct: number;
  }[];
  generadoEn: Date;
};

const CACHE_CATALOGO = 'panel:catalogo';
const CACHE_CATALOGO_TTL = 300;

export async function catalogoPanel(): Promise<CatalogoPanel | null> {
  const cacheado = await getJson<CatalogoPanel>(CACHE_CATALOGO);
  if (cacheado) return { ...cacheado, generadoEn: new Date(cacheado.generadoEn) };

  const pool = getPool();
  if (!pool) return null;
  try {
    const [cursos, modulos] = await Promise.all([
      pool.query(
        `SELECT c.codigo, c.nombre, c.estado, c.duracion_min,
                (SELECT count(*)::int FROM module m WHERE m.course_id = c.id) AS modulos,
                (SELECT count(*)::int FROM lesson l JOIN module m ON m.id = l.module_id
                  WHERE m.course_id = c.id) AS lecciones,
                (SELECT count(*)::int FROM enrollment e WHERE e.course_id = c.id) AS inscritas,
                (SELECT count(*)::int FROM enrollment e
                  WHERE e.course_id = c.id AND e.estado = 'completada') AS completadas,
                (SELECT COALESCE(round(avg(e.minutos_acumulados)), 0)::int FROM enrollment e
                  WHERE e.course_id = c.id) AS minutos,
                COALESCE((
                  SELECT round(avg(x.pct))::int FROM (
                    SELECT count(lp.id) FILTER (WHERE lp.estado = 'completada')::float
                           / NULLIF((SELECT count(*) FROM lesson l2 JOIN module m2 ON m2.id = l2.module_id
                                      WHERE m2.course_id = c.id), 0) * 100 AS pct
                      FROM enrollment e LEFT JOIN lesson_progress lp ON lp.enrollment_id = e.id
                     WHERE e.course_id = c.id GROUP BY e.id
                  ) x), 0) AS avance_pct
           FROM course c
          ORDER BY (c.estado = 'activo') DESC, c.codigo`,
      ),
      pool.query(
        `SELECT c.nombre AS curso, m.orden, m.nombre,
                count(DISTINCT l.id)::int AS lecciones,
                count(lp.id) FILTER (WHERE lp.estado = 'entregada')::int AS entregadas,
                count(lp.id) FILTER (WHERE lp.estado = 'completada')::int AS completadas
           FROM module m
           JOIN course c ON c.id = m.course_id AND c.estado = 'activo'
           JOIN lesson l ON l.module_id = m.id
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id
          GROUP BY c.nombre, m.orden, m.nombre
          ORDER BY m.orden`,
      ),
    ]);

    const salida: CatalogoPanel = {
      cursos: cursos.rows.map((r: any) => ({
        codigo: r.codigo, nombre: r.nombre, estado: r.estado, modulos: r.modulos,
        lecciones: r.lecciones, duracionMin: r.duracion_min, inscritas: r.inscritas,
        completadas: r.completadas, avancePct: r.avance_pct, minutosPromedio: r.minutos,
      })),
      modulos: modulos.rows.map((r: any) => {
        const total = r.entregadas + r.completadas;
        return {
          curso: r.curso, orden: r.orden, nombre: r.nombre, lecciones: r.lecciones,
          entregadas: r.entregadas, completadas: r.completadas,
          pct: total > 0 ? Math.round((r.completadas / total) * 100) : 0,
        };
      }),
      generadoEn: new Date(),
    };
    await setJson(CACHE_CATALOGO, salida, CACHE_CATALOGO_TTL);
    return salida;
  } catch (e) {
    log.warn('panel: catalogoPanel falló', { err: String(e) });
    return null;
  }
}
