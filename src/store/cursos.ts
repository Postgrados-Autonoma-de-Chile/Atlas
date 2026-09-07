import { getPool } from './db';
import { log } from '../log';

// Repositorio de cursos y progreso (Fase 4). Regla de la auditoría: los datos académicos van SIEMPRE
// por lookup exacto en Postgres (nunca por RAG ni por memoria del LLM), y las escrituras de progreso
// son TRANSACCIONALES (completar lección + minutos + detección de fin de curso en una sola tx).

export type Leccion = {
  id: string;
  orden: number;
  titulo: string;
  descripcion: string | null;
  tipo: 'capsula' | 'actividad_cierre';
  duracionMin: number;
  /** Materiales asociados (video/documento) con URL si existen. */
  materiales: { tipo: string; titulo: string | null; url: string | null }[];

  // ── Ficha de diseño de la microcápsula (plan curricular oficial) ──────────
  /** Paso de la ruta DEFINO → PREGUNTO → ORGANIZO → VERIFICO → DECIDO que trabaja esta cápsula.
   *  El plan exige que la ruta permanezca visible durante todo el recorrido. */
  pasoRuta: string | null;
  proposito: string | null;
  /** Pregunta con que el documento abre la cápsula ("¿Tengo claro lo que necesito resolver?"). */
  preguntaMovilizadora: string | null;
  productoEvidencia: string | null;
  resultadosObservables: string[];
  /** Guion del Anfitrión. El plan le da presencia SOLO al inicio y al cierre de cada cápsula:
   *  humaniza el recorrido sin asumir el rol de profesor. En WhatsApp no hay video, pero el texto
   *  del guion se entrega igual — es contenido curricular, no una acotación de producción. */
  guionApertura: string | null;
  guionCierre: string | null;
};

export type EstadoAcademico = {
  inscrito: boolean;
  curso?: { id: string; codigo: string; nombre: string; duracionMin: number };
  enrollment?: { id: string; estado: 'activa' | 'completada' | 'abandonada'; minutosAcumulados: number };
  totalLecciones?: number;
  completadas?: number;
  /** Próxima lección no completada (la actual), si el curso sigue activo. */
  proxima?: { orden: number; titulo: string; tipo: string; duracionMin: number };
};

/** Curso activo del piloto (hay uno solo; multi-curso llega post-piloto). */
export async function cursoActivo(): Promise<{ id: string; codigo: string; nombre: string; descripcion: string | null; duracionMin: number } | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT id, codigo, nombre, descripcion, duracion_min FROM course WHERE estado='activo' ORDER BY created_at LIMIT 1`,
    );
    const c = r.rows[0];
    return c ? { id: c.id, codigo: c.codigo, nombre: c.nombre, descripcion: c.descripcion, duracionMin: c.duracion_min } : null;
  } catch (e) {
    log.warn('cursos: cursoActivo falló', { err: String(e) });
    return null;
  }
}

/** Inscribe a la persona en el curso activo (idempotente). Devuelve el estado académico resultante. */
export async function inscribir(personId: string): Promise<EstadoAcademico | null> {
  const pool = getPool();
  if (!pool) return null;
  const curso = await cursoActivo();
  if (!curso) return { inscrito: false };
  try {
    await pool.query(
      `INSERT INTO enrollment (person_id, course_id) VALUES ($1,$2)
       ON CONFLICT ON CONSTRAINT enrollment_unico DO NOTHING`,
      [personId, curso.id],
    );
    return estadoAcademico(personId);
  } catch (e) {
    log.warn('cursos: inscribir falló', { err: String(e) });
    return null;
  }
}

/** Estado académico completo de la persona en el curso activo (rehidratación y tool de progreso). */
export async function estadoAcademico(personId: string): Promise<EstadoAcademico | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT c.id AS course_id, c.codigo, c.nombre, c.duracion_min,
              e.id AS enrollment_id, e.estado, e.minutos_acumulados,
              (SELECT count(*)::int FROM lesson l JOIN module m ON m.id = l.module_id WHERE m.course_id = c.id) AS total,
              (SELECT count(*)::int FROM lesson_progress lp WHERE lp.enrollment_id = e.id AND lp.estado='completada') AS completadas
       FROM enrollment e JOIN course c ON c.id = e.course_id
       WHERE e.person_id = $1 AND c.estado = 'activo'
       ORDER BY e.iniciado_en DESC LIMIT 1`,
      [personId],
    );
    const row = r.rows[0];
    if (!row) return { inscrito: false };

    const prox = await pool.query(
      `SELECT l.orden, l.titulo, l.tipo, l.duracion_min
       FROM lesson l JOIN module m ON m.id = l.module_id
       WHERE m.course_id = $1
         AND NOT EXISTS (SELECT 1 FROM lesson_progress lp
                         WHERE lp.enrollment_id = $2 AND lp.lesson_id = l.id AND lp.estado='completada')
       ORDER BY m.orden, l.orden LIMIT 1`,
      [row.course_id, row.enrollment_id],
    );
    const p = prox.rows[0];
    return {
      inscrito: true,
      curso: { id: row.course_id, codigo: row.codigo, nombre: row.nombre, duracionMin: row.duracion_min },
      enrollment: { id: row.enrollment_id, estado: row.estado, minutosAcumulados: row.minutos_acumulados },
      totalLecciones: row.total,
      completadas: row.completadas,
      proxima: p ? { orden: p.orden, titulo: p.titulo, tipo: p.tipo, duracionMin: p.duracion_min } : undefined,
    };
  } catch (e) {
    log.warn('cursos: estadoAcademico falló', { err: String(e) });
    return null;
  }
}

/** Entrega la lección actual (la primera no completada): la marca 'entregada' y devuelve su detalle. */
export async function entregarLeccionActual(personId: string): Promise<{ leccion: Leccion; posicion: string } | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const estado = await estadoAcademico(personId);
    if (!estado?.inscrito || !estado.enrollment || estado.enrollment.estado !== 'activa') return null;

    const r = await pool.query(
      `SELECT l.id, l.orden, l.titulo, l.descripcion, l.tipo, l.duracion_min,
              l.paso_ruta, l.proposito, l.pregunta_movilizadora, l.producto_evidencia,
              l.resultados_observables, l.guion_apertura, l.guion_cierre
       FROM lesson l JOIN module m ON m.id = l.module_id
       WHERE m.course_id = $1
         AND NOT EXISTS (SELECT 1 FROM lesson_progress lp
                         WHERE lp.enrollment_id = $2 AND lp.lesson_id = l.id AND lp.estado='completada')
       ORDER BY m.orden, l.orden LIMIT 1`,
      [estado.curso!.id, estado.enrollment.id],
    );
    const l = r.rows[0];
    if (!l) return null;

    await pool.query(
      `INSERT INTO lesson_progress (enrollment_id, lesson_id, estado) VALUES ($1,$2,'entregada')
       ON CONFLICT ON CONSTRAINT lesson_progress_unico DO NOTHING`,
      [estado.enrollment.id, l.id],
    );
    // Solo materiales CON enlace. El corpus del RAG se guarda como content_item de tipo
    // 'material' y sin url —es texto para buscar, no un recurso que se abra—, así que sin este
    // filtro aparecía en la lista de materiales de la lección y el tutor invitaba a "revisar el
    // material" señalando algo que el estudiante no puede abrir en ninguna parte.
    const mats = await pool.query(
      `SELECT tipo, titulo, url FROM content_item
        WHERE lesson_id = $1 AND tipo IN ('video','documento','material') AND url IS NOT NULL
        ORDER BY created_at`,
      [l.id],
    );
    return {
      leccion: {
        id: l.id, orden: l.orden, titulo: l.titulo, descripcion: l.descripcion,
        tipo: l.tipo, duracionMin: l.duracion_min,
        materiales: mats.rows.map((m: any) => ({ tipo: m.tipo, titulo: m.titulo, url: m.url })),
        pasoRuta: l.paso_ruta ?? null,
        proposito: l.proposito ?? null,
        preguntaMovilizadora: l.pregunta_movilizadora ?? null,
        productoEvidencia: l.producto_evidencia ?? null,
        resultadosObservables: Array.isArray(l.resultados_observables) ? l.resultados_observables : [],
        guionApertura: l.guion_apertura ?? null,
        guionCierre: l.guion_cierre ?? null,
      },
      posicion: `${l.orden} de ${estado.totalLecciones}`,
    };
  } catch (e) {
    log.warn('cursos: entregarLeccionActual falló', { err: String(e) });
    return null;
  }
}

export type ResultadoCompletar = {
  /** pasoRuta permite que el flujo sepa QUÉ microcápsula se cerró sin volver a consultarla: la 2
   *  (DEFINO) ofrece después el campo personal que su documento define. */
  completada: { id: string; orden: number; titulo: string; pasoRuta: string | null };
  minutosAcumulados: number;
  cursoCompletado: boolean;
  siguiente?: { orden: number; titulo: string };
};

/**
 * Completa la lección actual en UNA transacción: progreso → minutos → detección de fin de curso.
 * Si era la última, la inscripción pasa a 'completada' (F8 leerá este estado para certificar).
 * Devuelve { requiereEntrega } si la lección actual nunca fue entregada (continuar_curso primero).
 */
export async function completarLeccionActual(
  personId: string,
): Promise<ResultadoCompletar | { requiereEntrega: { orden: number; titulo: string } } | null> {
  const pool = getPool();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE OF e: sin el OF, el join bloqueaba también la fila del ÚNICO curso activo,
    // serializando las completaciones de todos los estudiantes (revisión F9.1).
    const e = await client.query(
      `SELECT e.id, e.course_id FROM enrollment e JOIN course c ON c.id = e.course_id
       WHERE e.person_id = $1 AND e.estado = 'activa' AND c.estado = 'activo'
       ORDER BY e.iniciado_en DESC LIMIT 1 FOR UPDATE OF e`,
      [personId],
    );
    const enr = e.rows[0];
    if (!enr) { await client.query('ROLLBACK'); return null; }

    const l = await client.query(
      `SELECT l.id, l.orden, l.titulo, l.duracion_min, l.paso_ruta
       FROM lesson l JOIN module m ON m.id = l.module_id
       WHERE m.course_id = $1
         AND NOT EXISTS (SELECT 1 FROM lesson_progress lp
                         WHERE lp.enrollment_id = $2 AND lp.lesson_id = l.id AND lp.estado='completada')
       ORDER BY m.orden, l.orden LIMIT 1`,
      [enr.course_id, enr.id],
    );
    const actual = l.rows[0];
    if (!actual) { await client.query('ROLLBACK'); return null; }

    // Integridad académica (revisión F9.1): solo se completa una lección ENTREGADA — sin esto,
    // repetir "terminé" fabricaba avance (y certificación) sin haber recibido contenido jamás.
    const entregada = await client.query(
      `SELECT 1 FROM lesson_progress WHERE enrollment_id=$1 AND lesson_id=$2`,
      [enr.id, actual.id],
    );
    if (!entregada.rows.length) {
      await client.query('ROLLBACK');
      return { requiereEntrega: { orden: actual.orden, titulo: actual.titulo } };
    }

    await client.query(
      `INSERT INTO lesson_progress (enrollment_id, lesson_id, estado, completado_en) VALUES ($1,$2,'completada',now())
       ON CONFLICT ON CONSTRAINT lesson_progress_unico
       DO UPDATE SET estado='completada', completado_en=now()`,
      [enr.id, actual.id],
    );
    const upd = await client.query(
      `UPDATE enrollment SET minutos_acumulados = minutos_acumulados + $2 WHERE id = $1 RETURNING minutos_acumulados`,
      [enr.id, actual.duracion_min],
    );

    const rest = await client.query(
      `SELECT l.orden, l.titulo FROM lesson l JOIN module m ON m.id = l.module_id
       WHERE m.course_id = $1
         AND NOT EXISTS (SELECT 1 FROM lesson_progress lp
                         WHERE lp.enrollment_id = $2 AND lp.lesson_id = l.id AND lp.estado='completada')
       ORDER BY m.orden, l.orden LIMIT 1`,
      [enr.course_id, enr.id],
    );
    const siguiente = rest.rows[0];
    const cursoCompletado = !siguiente;
    if (cursoCompletado) {
      await client.query(`UPDATE enrollment SET estado='completada', completado_en=now() WHERE id=$1`, [enr.id]);
      // La elegibilidad del certificado nace en ESTA misma transacción (F8): hecho persistido.
      await client.query(
        `INSERT INTO certificate (enrollment_id, person_id) VALUES ($1,$2)
         ON CONFLICT (enrollment_id) DO NOTHING`,
        [enr.id, personId],
      );
    }
    await client.query('COMMIT');
    return {
      completada: { id: actual.id, orden: actual.orden, titulo: actual.titulo, pasoRuta: actual.paso_ruta ?? null },
      minutosAcumulados: upd.rows[0].minutos_acumulados,
      cursoCompletado,
      siguiente: siguiente ? { orden: siguiente.orden, titulo: siguiente.titulo } : undefined,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('cursos: completarLeccionActual falló', { err: String(e) });
    return null;
  } finally {
    client.release();
  }
}

/**
 * Cómo se le cuenta a la persona que su avance anterior no se traslada.
 *
 * La instrucción viaja con el dato, no en el prompt del sistema: así el tutor la recibe solo cuando
 * corresponde y no gasta tokens en cada turno de los demás.
 */
export function frasePrevio(p: AvancePrevio): string {
  const hecho = p.folio
    ? `ya había COMPLETADO la versión anterior del programa ("${p.curso}") y tiene su certificado ${p.folio}, que sigue siendo válido`
    : `ya había avanzado ${p.completadas} de ${p.total} microcápsulas en la versión anterior del programa ("${p.curso}")`;
  return (
    `CONTEXTO IMPORTANTE: ${hecho}. El programa se actualizó al plan curricular oficial y esta ` +
    `versión tiene otras microcápsulas, así que ese avance NO se traslada y parte de nuevo. ` +
    `Reconócelo en UNA frase, con naturalidad, antes de ofrecerle inscribirse: no lo presentes como ` +
    `un error ni como una pérdida, no te disculpes de más, y NO prometas recuperar ese avance ni ` +
    `saltarse microcápsulas por haberlas hecho antes.`
  );
}

export type AvancePrevio = {
  curso: string;
  completadas: number;
  total: number;
  /** Folio si alcanzó a certificarse en esa versión. El certificado sigue siendo válido. */
  folio: string | null;
};

/**
 * Avance que la persona alcanzó en una versión ANTERIOR del programa, ya archivada.
 *
 * Cuando el currículo se actualiza, los cursos anteriores se archivan y `estadoAcademico` —que solo
 * mira el curso activo— empieza a devolver `inscrito: false`. Sin este dato, alguien que había
 * completado tres microcápsulas recibe la bienvenida de un estudiante nuevo, como si su trabajo no
 * hubiera existido.
 *
 * NO devuelve ese avance para trasladarlo: las microcápsulas de una versión y otra no se
 * corresponden, y darlas por equivalentes falsearía la evidencia. Es solo para poder reconocerlo.
 *
 * Devuelve null cuando no hay nada que reconocer: sin microcápsulas completadas y sin certificado,
 * mencionar una inscripción previa sería ruido.
 */
export async function avancePrevioArchivado(personId: string): Promise<AvancePrevio | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT c.nombre,
              (SELECT count(*)::int FROM lesson l JOIN module m ON m.id = l.module_id
                WHERE m.course_id = c.id) AS total,
              (SELECT count(*)::int FROM lesson_progress lp
                WHERE lp.enrollment_id = e.id AND lp.estado = 'completada') AS completadas,
              ct.folio
         FROM enrollment e
         JOIN course c ON c.id = e.course_id
         LEFT JOIN certificate ct ON ct.enrollment_id = e.id AND ct.folio IS NOT NULL
        WHERE e.person_id = $1 AND c.estado <> 'activo'
        ORDER BY completadas DESC, e.iniciado_en DESC
        LIMIT 1`,
      [personId],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (!row.completadas && !row.folio) return null;
    return { curso: row.nombre, completadas: row.completadas, total: row.total, folio: row.folio ?? null };
  } catch (e) {
    log.warn('cursos: avancePrevioArchivado falló', { err: String(e) });
    return null;
  }
}

/** Contexto académico compacto para rehidratar al tutor al abrir conversación (sin PII sensible). */
export async function contextoAcademico(personId: string, nombre: string | null): Promise<string> {
  const estado = await estadoAcademico(personId);
  const quien = nombre ? `Estudiante registrado: ${nombre}.` : 'Estudiante registrado.';
  if (!estado) return quien;
  if (!estado.inscrito) {
    const curso = await cursoActivo();
    if (!curso) return `${quien} No hay cursos disponibles por ahora.`;
    const previo = await avancePrevioArchivado(personId);
    const base = `${quien} Aún NO está inscrito en el curso disponible ("${curso.nombre}", ${curso.duracionMin} min en microcápsulas). Ofrécele inscribirse con la tool inscribirme_al_curso.`;
    return previo ? `${base} ${frasePrevio(previo)}` : base;
  }
  const { curso, enrollment, completadas, totalLecciones, proxima } = estado;
  if (enrollment!.estado === 'completada') {
    return `${quien} Completó el curso "${curso!.nombre}" (${enrollment!.minutosAcumulados} min acumulados). Puede obtener su certificado escribiendo "certificado" (el sistema conduce el proceso: RUT + verificación de correo).`;
  }
  const prox = proxima ? ` Próxima microcápsula: ${proxima.orden}. "${proxima.titulo}" (~${proxima.duracionMin} min).` : '';
  return `${quien} Curso "${curso!.nombre}": ${completadas}/${totalLecciones} microcápsulas completadas, ${enrollment!.minutosAcumulados} min acumulados.${prox} Si quiere continuar, usa la tool continuar_curso.`;
}
