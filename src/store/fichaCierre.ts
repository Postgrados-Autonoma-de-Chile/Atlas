import { getPool } from './db';
import { log } from '../log';

// Producto de cierre del Nivel Inicial: la ficha breve de resolución de problema con apoyo de IA.
//
// FUENTE: "Nivel 1 IA - Plan Nacional (Ajustado).docx" — «La persona aplica la ruta completa sobre
// una situación propia o un caso propuesto y registra: problema identificado; pregunta formulada;
// respuesta obtenida y forma en que la organizó; información que verificó o debería verificar; y
// decisión, acción o próximo paso posible. Esta actividad funciona como evidencia de aplicación,
// sin constituir una evaluación formal.»
//
// Los cinco campos NO son arbitrarios: son los cinco pasos de la ruta del curso. Llenar la ficha
// ES recorrer DEFINO → PREGUNTO → ORGANIZO → VERIFICO → DECIDO sobre un caso real.

/** Los cinco campos, en el orden en que el plan los enumera, con su paso de la ruta. */
export const CAMPOS_FICHA = [
  { campo: 'problema', paso: 'DEFINO' },
  { campo: 'pregunta_formulada', paso: 'PREGUNTO' },
  { campo: 'respuesta_obtenida', paso: 'ORGANIZO' },
  { campo: 'verificacion', paso: 'VERIFICO' },
  { campo: 'decision', paso: 'DECIDO' },
] as const;

export type CampoFicha = (typeof CAMPOS_FICHA)[number]['campo'];

export type Ficha = {
  id: string;
  enrollmentId: string;
  modalidad: 'propia' | 'caso_preparado' | null;
  problema: string | null;
  preguntaFormulada: string | null;
  respuestaObtenida: string | null;
  verificacion: string | null;
  decision: string | null;
  completadoEn: Date | null;
};

/** La inscripción activa de la persona en el curso activo, o null. */
async function inscripcionActiva(personId: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  const r = await pool.query(
    `SELECT e.id FROM enrollment e JOIN course c ON c.id = e.course_id
      WHERE e.person_id = $1 AND c.estado = 'activo'
      ORDER BY e.iniciado_en DESC LIMIT 1`,
    [personId],
  );
  return r.rows[0]?.id ?? null;
}

/** Crea la ficha si no existe y la devuelve. Idempotente. */
export async function abrirFicha(personId: string, modalidad?: 'propia' | 'caso_preparado'): Promise<Ficha | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const enrollmentId = await inscripcionActiva(personId);
    if (!enrollmentId) return null;
    const r = await pool.query(
      `INSERT INTO ficha_cierre (enrollment_id, modalidad) VALUES ($1,$2)
       ON CONFLICT (enrollment_id) DO UPDATE SET
         modalidad = COALESCE(ficha_cierre.modalidad, EXCLUDED.modalidad)
       RETURNING id, enrollment_id, modalidad, problema, pregunta_formulada, respuesta_obtenida,
                 verificacion, decision, completado_en`,
      [enrollmentId, modalidad ?? null],
    );
    return mapear(r.rows[0]);
  } catch (e) {
    log.error('fichaCierre: abrirFicha falló', { err: String(e) });
    return null;
  }
}

export async function fichaDePersona(personId: string): Promise<Ficha | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT f.id, f.enrollment_id, f.modalidad, f.problema, f.pregunta_formulada,
              f.respuesta_obtenida, f.verificacion, f.decision, f.completado_en
         FROM ficha_cierre f JOIN enrollment e ON e.id = f.enrollment_id
        WHERE e.person_id = $1
        ORDER BY f.created_at DESC LIMIT 1`,
      [personId],
    );
    return r.rows[0] ? mapear(r.rows[0]) : null;
  } catch (e) {
    log.warn('fichaCierre: fichaDePersona falló', { err: String(e) });
    return null;
  }
}

/**
 * Guarda un campo de la ficha. El nombre del campo se valida contra la lista blanca antes de
 * interpolarlo: son los cinco del plan y ninguno más.
 */
export async function guardarCampo(fichaId: string, campo: CampoFicha, texto: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  if (!CAMPOS_FICHA.some((c) => c.campo === campo)) {
    log.error('fichaCierre: campo no permitido', { campo });
    return false;
  }
  try {
    await pool.query(`UPDATE ficha_cierre SET ${campo} = $2 WHERE id = $1`, [fichaId, texto]);
    return true;
  } catch (e) {
    log.error('fichaCierre: guardarCampo falló', { campo, err: String(e) });
    return false;
  }
}

/** Cierra la ficha si los cinco campos están llenos. Devuelve true si quedó completa. */
export async function cerrarSiCompleta(fichaId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(
      `UPDATE ficha_cierre SET completado_en = now()
        WHERE id = $1 AND completado_en IS NULL
          AND problema IS NOT NULL AND pregunta_formulada IS NOT NULL
          AND respuesta_obtenida IS NOT NULL AND verificacion IS NOT NULL AND decision IS NOT NULL
        RETURNING id`,
      [fichaId],
    );
    if (r.rowCount) return true;
    const ya = await pool.query(`SELECT completado_en IS NOT NULL AS ok FROM ficha_cierre WHERE id=$1`, [fichaId]);
    return Boolean(ya.rows[0]?.ok);
  } catch (e) {
    log.warn('fichaCierre: cerrarSiCompleta falló', { err: String(e) });
    return false;
  }
}

/**
 * Nota personal que la persona escribió en la microcápsula 2, si la escribió.
 *
 * El documento de esa cápsula lo pide explícitamente: «Si la plataforma permite persistencia, la
 * frase personal puede recuperarse en la cápsula 8». Sin esto, quien ya redactó su necesidad
 * tendría que volver a escribirla desde cero.
 */
export async function notaDeMicrocapsula2(personId: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT n.texto FROM nota_estudiante n
         JOIN enrollment e ON e.id = n.enrollment_id
         JOIN lesson l ON l.id = n.lesson_id
        WHERE e.person_id = $1 AND l.paso_ruta = 'DEFINO'
        ORDER BY n.created_at DESC LIMIT 1`,
      [personId],
    );
    return r.rows[0]?.texto ?? null;
  } catch (e) {
    log.warn('fichaCierre: notaDeMicrocapsula2 falló', { err: String(e) });
    return null;
  }
}

/** Guarda la nota personal opcional de una microcápsula (campo "Mi necesidad" de la cápsula 2). */
export async function guardarNota(personId: string, lessonId: string, texto: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const enrollmentId = await inscripcionActiva(personId);
    if (!enrollmentId) return false;
    await pool.query(
      `INSERT INTO nota_estudiante (enrollment_id, lesson_id, texto) VALUES ($1,$2,$3)
       ON CONFLICT ON CONSTRAINT nota_estudiante_unica DO UPDATE SET texto=EXCLUDED.texto`,
      [enrollmentId, lessonId, texto],
    );
    return true;
  } catch (e) {
    log.warn('fichaCierre: guardarNota falló', { err: String(e) });
    return false;
  }
}

/** Primer campo sin llenar, en el orden del plan. null si la ficha está completa. */
export function siguienteCampo(f: Ficha): { campo: CampoFicha; paso: string } | null {
  const valor: Record<CampoFicha, string | null> = {
    problema: f.problema,
    pregunta_formulada: f.preguntaFormulada,
    respuesta_obtenida: f.respuestaObtenida,
    verificacion: f.verificacion,
    decision: f.decision,
  };
  const pendiente = CAMPOS_FICHA.find((c) => !valor[c.campo]);
  return pendiente ? { campo: pendiente.campo, paso: pendiente.paso } : null;
}

function mapear(r: any): Ficha {
  return {
    id: r.id,
    enrollmentId: r.enrollment_id,
    modalidad: r.modalidad ?? null,
    problema: r.problema ?? null,
    preguntaFormulada: r.pregunta_formulada ?? null,
    respuestaObtenida: r.respuesta_obtenida ?? null,
    verificacion: r.verificacion ?? null,
    decision: r.decision ?? null,
    completadoEn: r.completado_en ?? null,
  };
}
