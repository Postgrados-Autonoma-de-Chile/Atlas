import { getPool } from './db';
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
