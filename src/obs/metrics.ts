import { getRedisClient } from '../store/kv';

// Métricas técnicas (contadores + latencia LLM). Snapshot para /metrics.
// - Con Redis (producción): contadores en un hash y latencias en una lista acotada → agregadas
//   ENTRE réplicas. Las escrituras son fire-and-forget (no bloquean la ruta caliente ni fallan el turno).
// - Sin Redis (dev/test): contadores/latencias en memoria del proceso (comportamiento previo).
// Nota: las métricas de NEGOCIO del panel salen de Postgres (dbMetricsSummary) y ya son correctas
// entre réplicas; esto cubre solo los contadores técnicos y la latencia en vivo.

const memCounters: Record<string, number> = {};
const memLatencies: number[] = [];
const startedAt = new Date().toISOString();

const COUNTERS_KEY = 'metrics:counters';
const LATENCY_KEY = 'metrics:llm_latency';
const LATENCY_CAP = 500;

export function inc(name: string, n = 1): void {
  const redis = getRedisClient();
  if (redis) {
    void redis.hincrby(COUNTERS_KEY, name, n).catch(() => {});
    return;
  }
  memCounters[name] = (memCounters[name] ?? 0) + n;
}

export function recordLlmLatency(ms: number): void {
  const redis = getRedisClient();
  if (redis) {
    void redis.pipeline().lpush(LATENCY_KEY, String(ms)).ltrim(LATENCY_KEY, 0, LATENCY_CAP - 1).exec().catch(() => {});
    return;
  }
  memLatencies.push(ms);
  if (memLatencies.length > LATENCY_CAP) memLatencies.shift();
}

/** Suma tokens de una respuesta Anthropic (usage) a los contadores — incluye caché (F13):
 *  las lecturas de caché son el grueso del input real y cuestan 10× menos. */
export function recordTokens(usage: any): void {
  if (!usage) return;
  inc('tokens_in', Number(usage.input_tokens) || 0);
  inc('tokens_out', Number(usage.output_tokens) || 0);
  inc('tokens_cache_write', Number(usage.cache_creation_input_tokens) || 0);
  inc('tokens_cache_read', Number(usage.cache_read_input_tokens) || 0);
}

export type PreciosLlm = { inUsd: number; outUsd: number; cacheWriteUsd: number; cacheReadUsd: number };

/** Costo LLM estimado (USD) desde los contadores de tokens y precios por MTok (puro, F13). */
export function costoEstimadoUsd(counters: Record<string, number>, p: PreciosLlm): number {
  const usd =
    ((counters['tokens_in'] ?? 0) * p.inUsd +
      (counters['tokens_out'] ?? 0) * p.outUsd +
      (counters['tokens_cache_write'] ?? 0) * p.cacheWriteUsd +
      (counters['tokens_cache_read'] ?? 0) * p.cacheReadUsd) /
    1_000_000;
  return Math.round(usd * 10000) / 10000;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

export async function snapshot() {
  const redis = getRedisClient();
  let counters: Record<string, number> = memCounters;
  let latencies: number[] = memLatencies;

  if (redis) {
    try {
      const [hash, list] = await Promise.all([
        redis.hgetall(COUNTERS_KEY),
        redis.lrange(LATENCY_KEY, 0, LATENCY_CAP - 1),
      ]);
      counters = Object.fromEntries(Object.entries(hash).map(([k, v]) => [k, Number(v) || 0]));
      latencies = list.map(Number).filter((n) => !Number.isNaN(n));
    } catch {
      // Ante fallo de Redis, devuelve lo que haya en memoria (posiblemente vacío): mejor que romper /metrics.
      counters = { ...memCounters };
      latencies = [...memLatencies];
    }
  }

  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return {
    startedAt,
    counters,
    llm: { samples: latencies.length, avgMs: avg, p95Ms: pct(latencies, 95) },
  };
}
