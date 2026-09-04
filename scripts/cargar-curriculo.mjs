#!/usr/bin/env node
/**
 * Carga el plan curricular oficial desde curriculo/nivel1.json a la base de datos.
 *
 *   node scripts/cargar-curriculo.mjs [--archivar-otros] [--dry-run]
 *
 * IDEMPOTENTE: se puede volver a correr cuando el material curricular cambie. Reconcilia
 * por códigos y órdenes estables, así que no duplica ni pierde el avance de nadie —
 * lesson_progress apunta a lesson.id, que se conserva.
 *
 * El currículo vive en un JSON versionado y no dentro de una migración ni de un prompt:
 * ajustar el material no debe exigir tocar la lógica del bot.
 *
 * FUENTE: "Material Curricular_ PLAN _Alfabetización Ciudadana en Inteligencia Artificial_"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archivar = process.argv.includes('--archivar-otros');
const simular = process.argv.includes('--dry-run');

const doc = JSON.parse(fs.readFileSync(path.join(RAIZ, 'curriculo', 'nivel1.json'), 'utf8'));

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** El plan no subdivide el nivel en módulos: son 8 microcápsulas bajo un único bloque.
 *  Inventar una modularización sería inventar currículo, así que se crea uno solo. */
const MODULO = { orden: 1, nombre: 'IA para resolver problemas diarios' };

const resumen = { curso: '', lecciones: 0, interacciones: 0, items: 0, preguntas: 0, opciones: 0, archivados: 0 };

async function cargar(c) {
  const { curso, microcapsulas, caracterizacion, ruta, version } = doc;

  // ── Curso ────────────────────────────────────────────────────────────────
  const duracion = microcapsulas.reduce((s, m) => s + m.duracion_min, 0);
  const r = await c.query(
    `INSERT INTO course (codigo, nombre, descripcion, proposito, competencia, resultados_generales,
                         certificacion, producto_cierre, version_curriculo, estado, duracion_min)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'activo',$10)
     ON CONFLICT (codigo) DO UPDATE SET
       nombre=EXCLUDED.nombre, descripcion=EXCLUDED.descripcion, proposito=EXCLUDED.proposito,
       competencia=EXCLUDED.competencia, resultados_generales=EXCLUDED.resultados_generales,
       certificacion=EXCLUDED.certificacion, producto_cierre=EXCLUDED.producto_cierre,
       version_curriculo=EXCLUDED.version_curriculo, estado='activo', duracion_min=EXCLUDED.duracion_min
     RETURNING id`,
    [curso.codigo, curso.nombre, curso.descripcion, curso.proposito, curso.competencia,
      JSON.stringify({ resultados: curso.resultados_generales, ruta }), curso.certificacion,
      curso.producto_cierre, version, duracion],
  );
  const cursoId = r.rows[0].id;
  resumen.curso = `${curso.codigo} (${duracion} min)`;

  // ── Módulo único ─────────────────────────────────────────────────────────
  const m = await c.query(
    `INSERT INTO module (course_id, orden, nombre)
     VALUES ($1,$2,$3)
     ON CONFLICT ON CONSTRAINT module_orden_unico DO UPDATE SET nombre=EXCLUDED.nombre
     RETURNING id`,
    [cursoId, MODULO.orden, MODULO.nombre],
  );
  const moduloId = m.rows[0].id;

  // ── Microcápsulas ────────────────────────────────────────────────────────
  for (const mc of microcapsulas) {
    const l = await c.query(
      `INSERT INTO lesson (module_id, orden, titulo, descripcion, tipo, duracion_min,
                           paso_ruta, proposito, pregunta_movilizadora, producto_evidencia,
                           resultados_observables, guion_apertura, guion_cierre, fuente_curricular)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       ON CONFLICT ON CONSTRAINT lesson_orden_unico DO UPDATE SET
         titulo=EXCLUDED.titulo, descripcion=EXCLUDED.descripcion, tipo=EXCLUDED.tipo,
         duracion_min=EXCLUDED.duracion_min, paso_ruta=EXCLUDED.paso_ruta,
         proposito=EXCLUDED.proposito, pregunta_movilizadora=EXCLUDED.pregunta_movilizadora,
         producto_evidencia=EXCLUDED.producto_evidencia,
         resultados_observables=EXCLUDED.resultados_observables,
         guion_apertura=EXCLUDED.guion_apertura, guion_cierre=EXCLUDED.guion_cierre,
         fuente_curricular=EXCLUDED.fuente_curricular
       RETURNING id`,
      [moduloId, mc.orden, mc.titulo, mc.proposito, mc.tipo, mc.duracion_min, mc.paso_ruta,
        mc.proposito, mc.pregunta_movilizadora, mc.producto_evidencia,
        JSON.stringify(mc.resultados_observables), mc.guion_apertura, mc.guion_cierre, mc.fuente],
    );
    const lessonId = l.rows[0].id;
    resumen.lecciones++;

    await cargarInteraccion(c, lessonId, mc);
  }

  // ── Caracterización ──────────────────────────────────────────────────────
  for (const p of caracterizacion.preguntas) {
    const q = await c.query(
      `INSERT INTO survey_question (codigo, orden, seccion, enunciado)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (codigo) DO UPDATE SET
         orden=EXCLUDED.orden, seccion=EXCLUDED.seccion, enunciado=EXCLUDED.enunciado, estado='activo'
       RETURNING id`,
      [p.codigo, p.numero, p.seccion, p.enunciado],
    );
    const qid = q.rows[0].id;
    resumen.preguntas++;
    // Se borran las opciones que ya no existan en el material, por orden.
    await c.query(`DELETE FROM survey_option WHERE question_id=$1 AND orden > $2`, [qid, p.opciones.length]);
    for (const [i, texto] of p.opciones.entries()) {
      await c.query(
        `INSERT INTO survey_option (question_id, orden, texto) VALUES ($1,$2,$3)
         ON CONFLICT ON CONSTRAINT survey_option_orden_unico DO UPDATE SET texto=EXCLUDED.texto`,
        [qid, i + 1, texto],
      );
      resumen.opciones++;
    }
  }

  // ── Cursos anteriores ────────────────────────────────────────────────────
  // No se borran: hay personas inscritas y un certificado emitido. Se archivan, así
  // que cursoActivo() devuelve el currículo oficial y nadie pierde su historial.
  if (archivar) {
    const a = await c.query(
      `UPDATE course SET estado='archivado' WHERE codigo <> $1 AND estado <> 'archivado' RETURNING codigo`,
      [curso.codigo],
    );
    resumen.archivados = a.rowCount;
    if (a.rowCount) console.log(`  archivados: ${a.rows.map((x) => x.codigo).join(', ')}`);
  }
}

/**
 * Carga el momento "Lo intento" de una microcápsula, que el plan exige en cada una:
 * «al menos una acción breve del participante: elegir, ordenar, comparar, clasificar,
 * mejorar una solicitud o aplicar una pauta».
 *
 * Los cuatro tipos se representan sobre las mismas tablas de evaluación:
 *   seleccion_unica / seleccion_multiple / eleccion → UNA pregunta, los ítems son opciones
 *   clasificacion                                   → UNA pregunta POR ítem, las categorías
 *                                                     son las opciones
 */
async function cargarInteraccion(c, lessonId, mc) {
  const it = mc.interaccion;
  const q = await c.query(
    `INSERT INTO quiz (lesson_id, titulo, tipo_interaccion, consigna, retroalimentacion, minimo_requerido)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (lesson_id) DO UPDATE SET
       titulo=EXCLUDED.titulo, tipo_interaccion=EXCLUDED.tipo_interaccion,
       consigna=EXCLUDED.consigna, retroalimentacion=EXCLUDED.retroalimentacion,
       minimo_requerido=EXCLUDED.minimo_requerido, estado='activo'
     RETURNING id`,
    [lessonId, `Lo intento — ${mc.titulo}`, it.tipo, it.consigna, it.retroalimentacion, it.minimo_requerido],
  );
  const quizId = q.rows[0].id;
  resumen.interacciones++;

  const sinCorrecta = it.tipo === 'seleccion_multiple' || it.tipo === 'eleccion';

  if (it.tipo === 'clasificacion') {
    const categorias = [...new Set(it.items.map((i) => i.categoria).filter(Boolean))];
    await c.query(`DELETE FROM question WHERE quiz_id=$1 AND orden > $2`, [quizId, it.items.length]);
    for (const [i, item] of it.items.entries()) {
      const qq = await c.query(
        `INSERT INTO question (quiz_id, orden, tipo, enunciado, explicacion, sin_respuesta_correcta, item_texto)
         VALUES ($1,$2,'clasificacion',$3,$4,false,$5)
         ON CONFLICT ON CONSTRAINT question_orden_unico DO UPDATE SET
           tipo='clasificacion', enunciado=EXCLUDED.enunciado, explicacion=EXCLUDED.explicacion,
           sin_respuesta_correcta=false, item_texto=EXCLUDED.item_texto
         RETURNING id`,
        [quizId, i + 1, item.texto, it.retroalimentacion, item.texto],
      );
      await opciones(c, qq.rows[0].id, categorias.map((cat) => ({ texto: cat, correcta: cat === item.categoria })));
      resumen.items++;
    }
    return;
  }

  await c.query(`DELETE FROM question WHERE quiz_id=$1 AND orden > 1`, [quizId]);
  const qq = await c.query(
    `INSERT INTO question (quiz_id, orden, tipo, enunciado, explicacion, sin_respuesta_correcta)
     VALUES ($1,1,$2,$3,$4,$5)
     ON CONFLICT ON CONSTRAINT question_orden_unico DO UPDATE SET
       tipo=EXCLUDED.tipo, enunciado=EXCLUDED.enunciado, explicacion=EXCLUDED.explicacion,
       sin_respuesta_correcta=EXCLUDED.sin_respuesta_correcta
     RETURNING id`,
    [quizId, it.tipo === 'eleccion' ? 'eleccion' : 'seleccion_multiple',
      it.consigna, it.retroalimentacion, sinCorrecta],
  );
  await opciones(c, qq.rows[0].id, it.items.map((i) => ({ texto: i.texto, correcta: Boolean(i.correcta) })));
  resumen.items += it.items.length;
}

async function opciones(c, questionId, lista) {
  await c.query(`DELETE FROM question_option WHERE question_id=$1 AND orden > $2`, [questionId, lista.length]);
  for (const [i, o] of lista.entries()) {
    await c.query(
      `INSERT INTO question_option (question_id, orden, texto, es_correcta) VALUES ($1,$2,$3,$4)
       ON CONFLICT ON CONSTRAINT question_option_orden_unico DO UPDATE SET
         texto=EXCLUDED.texto, es_correcta=EXCLUDED.es_correcta`,
      [questionId, i + 1, o.texto, o.correcta],
    );
  }
}

const c = await pool.connect();
try {
  await c.query('BEGIN');
  await cargar(c);
  if (simular) {
    await c.query('ROLLBACK');
    console.log('\n--dry-run: se deshizo todo. Resumen de lo que HARÍA:');
  } else {
    await c.query('COMMIT');
    console.log('\ncargado:');
  }
  for (const [k, v] of Object.entries(resumen)) console.log(`  ${k.padEnd(14)} ${v}`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error('\nfalló, nada se aplicó:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
