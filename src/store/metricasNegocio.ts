import { getPool } from './db';
import { log } from '../log';

// Métricas de NEGOCIO del requisito §20 (F13), leídas de las tablas reales — nunca de agregaciones
// sobre el log de auditoría (antipatrón heredado que la auditoría marcó). Consulta única y barata
// (subselects con índices); el panel/scrape la pide, no la ruta caliente.

export type ResumenNegocio = {
  personas: number;
  personas7d: number;
  inscripcionesActivas: number;
  cursosCompletados: number;
  leccionesCompletadas: number;
  lecciones7d: number;
  quizzesFinalizados: number;
  quizzes7d: number;
  tasaCorrectas: number | null;
  certificados: Record<string, number>;
  recordatorios: Record<string, number>;
};

export async function dbResumenNegocio(): Promise<ResumenNegocio | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const [gral, cert, rem, correctas] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT count(*)::int FROM person) AS personas,
          (SELECT count(*)::int FROM person WHERE created_at > now() - interval '7 days') AS personas_7d,
          (SELECT count(*)::int FROM enrollment WHERE estado='activa') AS inscripciones_activas,
          (SELECT count(*)::int FROM enrollment WHERE estado='completada') AS cursos_completados,
          (SELECT count(*)::int FROM lesson_progress WHERE estado='completada') AS lecciones,
          (SELECT count(*)::int FROM lesson_progress WHERE estado='completada' AND completado_en > now() - interval '7 days') AS lecciones_7d,
          (SELECT count(*)::int FROM quiz_attempt WHERE finalizado_en IS NOT NULL) AS quizzes,
          (SELECT count(*)::int FROM quiz_attempt WHERE finalizado_en > now() - interval '7 days') AS quizzes_7d
      `),
      pool.query(`SELECT estado, count(*)::int c FROM certificate GROUP BY estado`),
      pool.query(`SELECT estado, count(*)::int c FROM reminder GROUP BY estado`),
      pool.query(`SELECT round(avg(CASE WHEN es_correcta THEN 100 ELSE 0 END))::int pct FROM attempt_answer`),
    ]);
    const g = gral.rows[0];
    const aMapa = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.estado, r.c]));
    return {
      personas: g.personas,
      personas7d: g.personas_7d,
      inscripcionesActivas: g.inscripciones_activas,
      cursosCompletados: g.cursos_completados,
      leccionesCompletadas: g.lecciones,
      lecciones7d: g.lecciones_7d,
      quizzesFinalizados: g.quizzes,
      quizzes7d: g.quizzes_7d,
      tasaCorrectas: correctas.rows[0]?.pct ?? null,
      certificados: aMapa(cert.rows),
      recordatorios: aMapa(rem.rows),
    };
  } catch (e) {
    log.warn('metricasNegocio: resumen falló', { err: String(e) });
    return null;
  }
}
