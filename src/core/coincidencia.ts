// Coincidencia tolerante para los flujos DETERMINISTAS (caracterización, evaluación, registro).
//
// Estos flujos no pasan por el LLM a propósito: son preguntas cerradas y el parsing debe ser
// predecible y gratis. Pero "exacto" no es lo mismo que "predecible": una persona escribiendo
// desde el teléfono comete dedazos, y exigir literalidad la deja sin salida. Esto agrega
// tolerancia a errores de tipeo SIN abrir la puerta a adivinar.

/** Minúsculas y sin tildes. La forma en que se compara todo aquí. */
export function plano(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/**
 * Distancia de edición (Levenshtein) con corte temprano: si supera `max` devuelve `max + 1` sin
 * terminar de calcular. El corte importa porque esto corre por cada opción de cada pregunta.
 */
export function distancia(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const fila = [i];
    let mejorEnFila = i;
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, fila[j - 1] + 1, prev[j - 1] + costo);
      fila.push(v);
      if (v < mejorEnFila) mejorEnFila = v;
    }
    if (mejorEnFila > max) return max + 1; // ninguna continuación puede bajar de aquí
    prev = fila;
  }
  return prev[b.length];
}

/**
 * Cuántos errores se le perdonan a una palabra según su largo. Las cortas no perdonan nada:
 * con 1 error de tolerancia, "no" se confundiría con "yo" y "si" con "mi".
 */
export function tolerancia(palabra: string): number {
  if (palabra.length <= 4) return 0;
  if (palabra.length <= 7) return 1;
  return 2;
}

/** ¿El texto contiene alguna palabra que se parezca a alguna de las claves? */
export function mencionaAlguna(texto: string, claves: string[]): boolean {
  const palabras = plano(texto).split(/[^a-z0-9ñ]+/).filter(Boolean);
  return palabras.some((w) =>
    claves.some((c) => {
      const t = tolerancia(c);
      return t === 0 ? w === c : distancia(w, c, t) <= t;
    }),
  );
}

/**
 * Elige la opción cuyo texto más se parece a lo escrito. Devuelve null si no hay una ganadora
 * CLARA: ante un empate prefiere no entender a registrar un dato equivocado, porque estas
 * respuestas son el insumo de una caracterización, no una conversación.
 */
export function elegirPorTexto(
  texto: string, opciones: { id: string; texto: string }[],
): string | null {
  const p = plano(texto);
  if (!p) return null;
  const puntajes = opciones
    .map((o) => {
      const t = plano(o.texto);
      const max = tolerancia(t);
      return { id: o.id, d: max === 0 ? (t === p ? 0 : 1) : distancia(p, t, max), max };
    })
    .filter((x) => x.d <= x.max)
    .sort((a, b) => a.d - b.d);
  if (puntajes.length === 0) return null;
  const [mejor, segunda] = puntajes;
  if (mejor.d === 0) return mejor.id;           // calza literal tras normalizar
  if (!segunda) return mejor.id;                // no hay con qué confundirla
  // Hay una rival cerca: solo se acepta la corrección si la ganadora es CLARAMENTE mejor. Un
  // dedazo no puede decidir entre alternativas opuestas —"mucho" y "poco" están a una letra de
  // "moco"— y en una encuesta eso invierte lo que la persona quiso decir.
  return segunda.d - mejor.d >= 2 ? mejor.id : null;
}
