// Chunking PURO de texto para el RAG (Fase 5). Objetivo ~500 tokens por chunk (aprox. 4 chars/token
// en español → ~2.000 caracteres), con solape del 15% y cortes preferentes en límites de párrafo u
// oración (nunca a mitad de palabra si se puede evitar). Determinista y testeable sin red.

export type Chunk = { orden: number; texto: string };

export type ChunkOpts = {
  /** Tamaño objetivo del chunk en caracteres (~500 tokens ≈ 2000 chars). */
  maxChars?: number;
  /** Solape entre chunks consecutivos, fracción del tamaño (0.15 = 15%). */
  solape?: number;
};

const DEFAULTS: Required<ChunkOpts> = { maxChars: 2000, solape: 0.15 };

/** Busca el mejor punto de corte ≤ limite: fin de párrafo > fin de oración > espacio. */
function puntoDeCorte(texto: string, limite: number): number {
  const ventana = texto.slice(0, limite);
  const parrafo = ventana.lastIndexOf('\n\n');
  if (parrafo > limite * 0.5) return parrafo + 2;
  const oracion = Math.max(ventana.lastIndexOf('. '), ventana.lastIndexOf('.\n'), ventana.lastIndexOf('? '), ventana.lastIndexOf('! '));
  if (oracion > limite * 0.5) return oracion + 2;
  const espacio = ventana.lastIndexOf(' ');
  return espacio > limite * 0.5 ? espacio + 1 : limite;
}

export function chunkTexto(texto: string, opts: ChunkOpts = {}): Chunk[] {
  const { maxChars, solape } = { ...DEFAULTS, ...opts };
  const limpio = String(texto ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!limpio) return [];
  if (limpio.length <= maxChars) return [{ orden: 0, texto: limpio }];

  const chunks: Chunk[] = [];
  const paso = Math.max(1, Math.floor(maxChars * (1 - solape)));
  let inicio = 0;
  let orden = 0;
  while (inicio < limpio.length) {
    const resto = limpio.slice(inicio);
    if (resto.length <= maxChars) {
      chunks.push({ orden, texto: resto.trim() });
      break;
    }
    const corte = puntoDeCorte(resto, maxChars);
    chunks.push({ orden, texto: resto.slice(0, corte).trim() });
    orden++;
    // Avanza con solape: retrocede desde el corte una fracción del tamaño.
    inicio += Math.max(paso, corte - Math.floor(maxChars * solape));
  }
  return chunks.filter((c) => c.texto.length > 0);
}
