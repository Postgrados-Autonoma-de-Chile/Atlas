// Harness de evaluación pedagógica (Fase 6) — corre el golden set E2E contra el motor REAL:
// mismo prompt, mismas tools, mismo RAG y mismo modelo que en producción; un juez (Haiku) califica.
//
// Requiere: ANTHROPIC_API_KEY + DATABASE_URL migrada con contenido ingerido (RAG) + GEMINI_API_KEY.
// Uso:      npx tsx scripts/evaluar-tutor.ts [--solo id1,id2]
// Salida:   eval/resultados-<fecha>.json + tabla en consola. Exit 1 si no cumple los umbrales.
//
// UMBRALES DE "LISTO PARA PILOTO" (auditoría §18): tasa de aprobación ≥ 0.90 · cita de fuente en
// contenido ≥ 0.90 · honestidad fuera-de-material = 1.00 · fidelidad promedio ≥ 4.
import { writeFileSync, mkdirSync } from 'node:fs';
import { initDb, getPool } from '../src/store/db';
import { runAgentTurn } from '../src/ai/agentLoop';
import { resetHistory } from '../src/ai/memory';
import { TUTOR_WHATSAPP_PROFILE } from '../src/core/channel';
import { cargarGoldenSet, juzgarRespuesta, resumenEvaluacion, type Veredicto } from '../src/eval/juez';

const UMBRAL = { tasaAprobacion: 0.9, citaFuenteContenido: 0.9, honestidadFuera: 1.0, fidelidadProm: 4 };

async function main() {
  const solo = (process.argv.find((a) => a.startsWith('--solo'))?.split('=')[1] ?? '').split(',').filter(Boolean);
  await initDb();
  if (!getPool()) console.warn('⚠ Sin BD: las tools académicas y el RAG degradarán — los casos de contenido probablemente reprueben.');

  const items = cargarGoldenSet('eval/golden-set.json').filter((i) => !solo.length || solo.includes(i.id));
  console.log(`Evaluando ${items.length} casos contra ${TUTOR_WHATSAPP_PROFILE.model}…\n`);

  const veredictos: (Veredicto | null)[] = [];
  const respuestas: string[] = [];
  for (const item of items) {
    const convId = `eval:${item.id}`;
    await resetHistory(convId); // cada caso parte con memoria limpia
    const t0 = Date.now();
    const respuesta = await runAgentTurn({ profile: TUTOR_WHATSAPP_PROFILE, conversationId: convId }, item.pregunta);
    const v = await juzgarRespuesta(item, respuesta);
    veredictos.push(v);
    respuestas.push(respuesta);
    const marca = v ? (v.aprobado ? '✔' : '✘') : '⚠';
    console.log(`${marca} ${item.id} [${item.tipo}] ${Date.now() - t0}ms ${v ? `fid=${v.fidelidad} cla=${v.claridad} tono=${v.tono}` : 'juez falló'}${v && !v.aprobado ? ` — ${v.comentario}` : ''}`);
  }

  const resumen = resumenEvaluacion(items, veredictos);
  console.log('\n── RESUMEN ─────────────────────────────');
  console.log(`aprobación: ${resumen.aprobados}/${resumen.juzgados} (${(resumen.tasaAprobacion * 100).toFixed(0)}%)  fidelidad: ${resumen.fidelidadProm}  claridad: ${resumen.claridadProm}  tono: ${resumen.tonoProm}`);
  console.log(`cita de fuente (contenido): ${(resumen.citaFuenteContenido * 100).toFixed(0)}%  honestidad (fuera de material): ${(resumen.honestidadFuera * 100).toFixed(0)}%`);

  mkdirSync('eval', { recursive: true });
  const archivo = `eval/resultados-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(
    archivo,
    JSON.stringify({ modelo: TUTOR_WHATSAPP_PROFILE.model, fecha: new Date().toISOString(), resumen, detalle: items.map((item, i) => ({ item, respuesta: respuestas[i], veredicto: veredictos[i] })) }, null, 2),
  );
  console.log(`detalle: ${archivo}`);

  const cumple =
    resumen.juzgados === items.length &&
    resumen.tasaAprobacion >= UMBRAL.tasaAprobacion &&
    resumen.citaFuenteContenido >= UMBRAL.citaFuenteContenido &&
    resumen.honestidadFuera >= UMBRAL.honestidadFuera &&
    resumen.fidelidadProm >= UMBRAL.fidelidadProm;
  if (!cumple) {
    console.error(`\n✘ Bajo los umbrales de piloto ${JSON.stringify(UMBRAL)}`);
    process.exit(1);
  }
  console.log('\n✔ Umbrales de piloto cumplidos.');
  process.exit(0);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
