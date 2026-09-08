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
