import { config } from '../config';
import { log } from '../log';

// Cliente de embeddings (Fase 5): gemini-embedding-001 vía Gemini API (API key simple, ideal para
// el piloto). En F11 puede migrarse a Vertex AI (mismo modelo, auth ADC) cambiando solo este módulo.
// Con dimensiones < 3072 (Matryoshka) los vectores NO vienen normalizados → normalizamos L2 aquí,
// para que la distancia coseno del índice HNSW sea correcta.

const BATCH_MAX = 100; // límite de la API por batchEmbedContents

export type TipoEmbedding = 'documento' | 'consulta';

const TASK: Record<TipoEmbedding, string> = {
  documento: 'RETRIEVAL_DOCUMENT',
  consulta: 'RETRIEVAL_QUERY',
};

export function normalizarL2(v: number[]): number[] {
  const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norma > 0 ? v.map((x) => x / norma) : v;
}

/** Payload de batchEmbedContents (puro, testeable). */
export function construirBatchRequest(textos: string[], tipo: TipoEmbedding) {
  return {
    requests: textos.map((text) => ({
      model: `models/${config.embeddingModel}`,
      content: { parts: [{ text }] },
      taskType: TASK[tipo],
      outputDimensionality: config.embeddingDim,
    })),
  };
}

/** Serializa un vector al literal de pgvector: '[0.1,0.2,...]'. */
export function vectorALiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Embeddings normalizados L2 de una lista de textos. null si no hay GEMINI_API_KEY o falla la API. */
export async function embedTextos(textos: string[], tipo: TipoEmbedding): Promise<number[][] | null> {
  if (!config.geminiApiKey) {
    log.warn('embeddings: sin GEMINI_API_KEY — RAG no disponible');
    return null;
  }
  const out: number[][] = [];
  try {
    for (let i = 0; i < textos.length; i += BATCH_MAX) {
      const lote = textos.slice(i, i + BATCH_MAX);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.embeddingModel}:batchEmbedContents`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': config.geminiApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(construirBatchRequest(lote, tipo)),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const json: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        log.warn('embeddings: la API respondió error', { status: r.status, detalle: json?.error?.message });
        return null;
      }
      const vectores = (json?.embeddings ?? []).map((e: any) => normalizarL2(e.values as number[]));
      if (vectores.length !== lote.length) {
        log.warn('embeddings: respuesta incompleta', { esperados: lote.length, recibidos: vectores.length });
        return null;
      }
      out.push(...vectores);
    }
    return out;
  } catch (e) {
    log.warn('embeddings: error de red', { err: String(e) });
    return null;
  }
}
