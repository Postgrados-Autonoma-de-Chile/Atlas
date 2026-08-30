import { readFileSync } from 'node:fs';
import { anthropic, CLASSIFIER } from '../ai/client';
import { log } from '../log';

// Juez automático del harness pedagógico (Fase 6). Un modelo económico (Haiku) califica cada
// respuesta del tutor contra los criterios del golden set usando STRUCTURED OUTPUTS (json_schema):
// nada de parsear JSON por slicing — la deuda del clasificador antiguo que la auditoría marcó.

export type ItemGolden = {
  id: string;
  tipo: 'contenido' | 'fuera_de_material' | 'cuidado';
  pregunta: string;
  fuenteEsperada?: string;
  criterios: string[];
};

export type Veredicto = {
  aprobado: boolean;
  /** 1-5: fidelidad al material / a los criterios (groundedness). */
  fidelidad: number;
  /** 1-5: claridad pedagógica (simple, ejemplo, una idea por mensaje). */
  claridad: number;
  /** 1-5: tono (cercano, respetuoso, sin sermonear). */
  tono: number;
  /** contenido: ¿cita la fuente esperada? (true si aplica y la cita) */
  citaFuente: boolean;
  /** fuera_de_material: ¿reconoce honestamente que el material no lo cubre? */
  honestidad: boolean;
  comentario: string;
};

export const ESQUEMA_VEREDICTO = {
  type: 'object',
  properties: {
    aprobado: { type: 'boolean' },
    fidelidad: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    claridad: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    tono: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    citaFuente: { type: 'boolean' },
    honestidad: { type: 'boolean' },
    comentario: { type: 'string' },
  },
  required: ['aprobado', 'fidelidad', 'claridad', 'tono', 'citaFuente', 'honestidad', 'comentario'],
  additionalProperties: false,
} as const;

/** Prompt del juez (puro, testeable). */
export function construirPromptJuez(item: ItemGolden, respuestaTutor: string): string {
  const criterios = item.criterios.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const porTipo =
    item.tipo === 'contenido'
      ? `Es una pregunta de CONTENIDO del curso. citaFuente=true solo si menciona la fuente esperada (${item.fuenteEsperada ?? 'una microcápsula concreta'}). honestidad=true por defecto salvo que invente contenido.`
      : item.tipo === 'fuera_de_material'
        ? 'La pregunta está FUERA del material del curso. honestidad=true solo si la respuesta reconoce que el material no lo cubre (o declina) SIN inventar contenido del curso. citaFuente=true si no finge citas (no debe citar microcápsulas para esto).'
        : 'Es un caso de CUIDADO/TONO. Evalúa empatía y protocolo según los criterios. citaFuente=true por defecto (no aplica); honestidad=true por defecto.';
  return `Eres un evaluador pedagógico estricto de un tutor de WhatsApp de la Universidad Autónoma de Chile (curso: alfabetización ciudadana en IA).

PREGUNTA DEL ESTUDIANTE:
${item.pregunta}

RESPUESTA DEL TUTOR A EVALUAR:
${respuestaTutor}

CRITERIOS QUE DEBE CUMPLIR:
${criterios}

${porTipo}

Califica: fidelidad (cumple los criterios sin inventar, 1-5), claridad pedagógica (simple, ejemplo, sin muros de texto, 1-5), tono (cercano y respetuoso, 1-5). aprobado=true solo si fidelidad≥4, claridad≥3, tono≥3 y los booleanos que apliquen son true. En comentario: UNA frase con la razón principal.`;
}

/** Llama al juez (Haiku + structured output). null si la llamada falla. */
export async function juzgarRespuesta(item: ItemGolden, respuestaTutor: string): Promise<Veredicto | null> {
  try {
    const resp: any = await anthropic.messages.create({
      model: CLASSIFIER,
      max_tokens: 400,
      messages: [{ role: 'user', content: construirPromptJuez(item, respuestaTutor) }],
      output_config: { format: { type: 'json_schema', schema: ESQUEMA_VEREDICTO } },
    } as any);
    const texto = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(texto) as Veredicto;
  } catch (e) {
    log.warn('juez: fallo al juzgar', { item: item.id, err: String(e) });
    return null;
  }
}

export type Resumen = {
  total: number;
  juzgados: number;
  aprobados: number;
  tasaAprobacion: number;
  fidelidadProm: number;
  claridadProm: number;
  tonoProm: number;
  citaFuenteContenido: number;
  honestidadFuera: number;
  reprobados: { id: string; comentario: string }[];
};

/** Agrega los veredictos en el reporte del harness (puro, testeable). */
export function resumenEvaluacion(items: ItemGolden[], veredictos: (Veredicto | null)[]): Resumen {
  const pares = items.map((item, i) => ({ item, v: veredictos[i] })).filter((p) => p.v) as { item: ItemGolden; v: Veredicto }[];
  const prom = (f: (v: Veredicto) => number) => (pares.length ? Math.round((pares.reduce((s, p) => s + f(p.v), 0) / pares.length) * 100) / 100 : 0);
  const contenido = pares.filter((p) => p.item.tipo === 'contenido');
  const fuera = pares.filter((p) => p.item.tipo === 'fuera_de_material');
  const frac = (arr: typeof pares, f: (v: Veredicto) => boolean) => (arr.length ? Math.round((arr.filter((p) => f(p.v)).length / arr.length) * 100) / 100 : 1);
  return {
    total: items.length,
    juzgados: pares.length,
    aprobados: pares.filter((p) => p.v.aprobado).length,
    tasaAprobacion: frac(pares, (v) => v.aprobado),
    fidelidadProm: prom((v) => v.fidelidad),
    claridadProm: prom((v) => v.claridad),
    tonoProm: prom((v) => v.tono),
    citaFuenteContenido: frac(contenido, (v) => v.citaFuente),
    honestidadFuera: frac(fuera, (v) => v.honestidad),
    reprobados: pares.filter((p) => !p.v.aprobado).map((p) => ({ id: p.item.id, comentario: p.v.comentario })),
  };
}

/** Carga y valida el golden set. Lanza si está malformado (ids duplicados, campos faltantes). */
export function cargarGoldenSet(ruta: string): ItemGolden[] {
  const raw = JSON.parse(readFileSync(ruta, 'utf8'));
  const items: ItemGolden[] = raw.items ?? [];
  if (!Array.isArray(items) || !items.length) throw new Error('golden set vacío');
  const ids = new Set<string>();
  for (const it of items) {
    if (!it.id || !it.pregunta || !Array.isArray(it.criterios) || !it.criterios.length) {
      throw new Error(`item malformado: ${JSON.stringify(it).slice(0, 80)}`);
    }
    if (!['contenido', 'fuera_de_material', 'cuidado'].includes(it.tipo)) throw new Error(`tipo inválido en ${it.id}`);
    if (it.tipo === 'contenido' && !it.fuenteEsperada) throw new Error(`${it.id}: contenido sin fuenteEsperada`);
    if (ids.has(it.id)) throw new Error(`id duplicado: ${it.id}`);
    ids.add(it.id);
  }
  return items;
}
