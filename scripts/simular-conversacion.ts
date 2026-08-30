// Simulador de conversación de punta a punta contra el backend desplegado (patrón E2E conservado
// de la auditoría). En Fase 10 apuntará al flujo real de WhatsApp (webhook firmado → worker);
// mientras tanto queda como esqueleto. BASE_URL es OBLIGATORIA: ya no hay fallback a producción
// (hallazgo de la auditoría: un tester distraído disparaba conversaciones contra prod).
// Uso: BASE_URL=http://localhost:3000 npx tsx scripts/simular-conversacion.ts <etiqueta> "<msg1>" ...
async function main() {
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('Define BASE_URL (sin fallback a producción).');
  const etiqueta = process.argv[2];
  const mensajes = process.argv.slice(3);
  if (!etiqueta || !mensajes.length) throw new Error('Uso: <etiqueta> "<msg1>" "<msg2>" ...');

  console.log(`[${etiqueta}] El canal conversacional de ATLAS llega en la Fase 10 (WhatsApp Cloud API).`);
  console.log(`[${etiqueta}] Verificando que el servicio responde: GET ${base}/health`);
  const r = await fetch(`${base}/health`);
  console.log(`[${etiqueta}] /health → ${r.status}: ${await r.text()}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
