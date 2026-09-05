// Mide el prefijo cacheable (system + esquemas de tools) del perfil del tutor con el endpoint
// count_tokens de Anthropic, y lo compara contra el mínimo cacheable del modelo. Sirve para confirmar
// si la caché de prompt (agentLoop.ts → cachedSystem) realmente aplica.
// Uso:  REDIS_URL= DATABASE_URL= npx tsx scripts/medir-tokens-prompt.ts
import { anthropic } from '../src/ai/client';
import { tools } from '../src/ai/tools';
import { TUTOR_WHATSAPP_PROFILE } from '../src/core/channel';

// Mínimo cacheable por modelo (tokens): por debajo de esto, cache_control no cachea (silencioso, no falla).
function minCacheable(model: string): number {
  if (/haiku/i.test(model)) return 4096;
  if (/sonnet/i.test(model)) return 2048;
  return 1024;
}

async function main() {
  const p = TUTOR_WHATSAPP_PROFILE;
  const withTools = tools.filter((t) => p.toolNames.includes(t.name));
  const r: any = await anthropic.messages.countTokens({
    model: p.model,
    system: p.systemPrompt,
    tools: withTools as any,
    messages: [{ role: 'user', content: 'hola' }],
  });
  const min = minCacheable(p.model);
  const n = r.input_tokens as number;
  console.log(`perfil=${p.id} modelo=${p.model} tokens_prefijo≈${n} min_cacheable=${min} → ${n >= min ? 'CACHEA' : 'NO cachea aún (prefijo corto)'}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
