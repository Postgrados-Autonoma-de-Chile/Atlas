// Verificador de invariantes de la prueba de carga (Fase 14): compara /metrics antes/después.
//
// Uso:
//   BASE_URL=... DASHBOARD_TOKEN=... npx tsx perf/verificar.ts antes            → guarda snapshot
//   BASE_URL=... DASHBOARD_TOKEN=... npx tsx perf/verificar.ts despues [opts]   → deltas + invariantes
//     opts: --enviados=N        mensajes ÚNICOS enviados por k6 (invariante: delta inbound == N)
//           --con-duplicados    la corrida fue el escenario C (cada wamid se envió 2 veces)
import { readFileSync, writeFileSync } from 'node:fs';

const SNAP = 'perf/.snapshot-antes.json';

async function leerMetrics(): Promise<any> {
  const base = (process.env.BASE_URL ?? '').replace(/\/$/, '');
  const token = process.env.DASHBOARD_TOKEN ?? '';
  if (!base || !token) throw new Error('Define BASE_URL y DASHBOARD_TOKEN');
  const r = await fetch(`${base}/metrics`, { headers: { 'x-dashboard-token': token } });
  if (!r.ok) throw new Error(`/metrics → HTTP ${r.status}`);
  return r.json();
}

const n = (v: unknown) => Number(v ?? 0);

async function main() {
  const modo = process.argv[2];
  const enviados = Number((process.argv.find((a) => a.startsWith('--enviados=')) ?? '').split('=')[1] ?? NaN);
  const conDuplicados = process.argv.includes('--con-duplicados');

  if (modo === 'antes') {
    writeFileSync(SNAP, JSON.stringify(await leerMetrics(), null, 2));
    console.log(`Snapshot guardado en ${SNAP}. Corre k6 y luego: verificar.ts despues --enviados=N`);
    return;
  }
  if (modo !== 'despues') throw new Error('Uso: antes | despues [--enviados=N] [--con-duplicados]');

  const antes = JSON.parse(readFileSync(SNAP, 'utf8'));
  const ahora = await leerMetrics();
  const delta = (k: string) => n(ahora.counters?.[k]) - n(antes.counters?.[k]);

  const dInbound = delta('inbound');
  const dReply = delta('reply');
  const dErrores = Object.keys({ ...ahora.counters, ...antes.counters })
    .filter((k) => k.startsWith('errors'))
    .reduce((s, k) => s + delta(k), 0);

  console.log(`inbound: +${dInbound} · reply: +${dReply} · errores: +${dErrores}`);
  console.log(`llm p95: ${ahora.llm?.p95Ms}ms · costo LLM acumulado: $${ahora.costoLlmUsd}`);

  const fallas: string[] = [];
  if (Number.isFinite(enviados)) {
    if (dInbound !== enviados) {
      fallas.push(
        conDuplicados
          ? `DUPLICADOS: inbound subió ${dInbound} pero se enviaron ${enviados} wamids únicos (cada uno 2 veces) — el dedupe dejó pasar ${dInbound - enviados}`
          : `PÉRDIDA/DUPLICACIÓN: inbound subió ${dInbound}, se esperaban ${enviados}`,
      );
    } else {
      console.log(`✔ dedupe/entrega correcta: ${enviados} únicos → inbound +${dInbound}`);
    }
  }
  if (dErrores > 0) fallas.push(`errores durante la corrida: +${dErrores} (revisar counters errors:*)`);
  if (dReply > dInbound) fallas.push(`reply (+${dReply}) > inbound (+${dInbound}): respuestas duplicadas`);

  if (fallas.length) {
    console.error('\n✘ INVARIANTES VIOLADOS:\n- ' + fallas.join('\n- '));
    process.exit(1);
  }
  console.log('\n✔ Invariantes OK.');
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
