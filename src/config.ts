import 'dotenv/config';

// Configuración central de ATLAS. Solo variables vigentes tras la Fase 1 (limpieza del bot de ventas).
// La validación estricta de esquema (fail-fast al arrancar) llega en Fase 2.
export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** URL pública del servicio (Cloud Run o túnel local), sin slash final. */
  baseUrl: (process.env.BASE_URL ?? '').replace(/\/$/, ''),

  // ── LLM (Anthropic) ──
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Modelo del tutor (razonador). */
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  /** Modelo económico para clasificación/resúmenes (juez de evaluaciones, Fase 7). */
  classifierModel: process.env.ANTHROPIC_CLASSIFIER ?? 'claude-haiku-4-5',

  // ── STT para notas de voz de estudiantes (la fuente del audio pasa a la Media API de Meta en Fase 10) ──
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? '',
  deepgramModel: process.env.DEEPGRAM_MODEL ?? 'nova-2',

  // ── Persistencia ──
  redisUrl: process.env.REDIS_URL ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgSsl: process.env.PGSSL === 'true',

  // ── Webhook de WhatsApp Cloud API (handshake GET + firma X-Hub-Signature-256) ──
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? '',
  metaAppSecret: process.env.META_APP_SECRET ?? '',

  // ── Observabilidad ──
  /** Protege /metrics. Solo por header (x-dashboard-token); nunca por query string. */
  dashboardToken: process.env.DASHBOARD_TOKEN ?? '',
  /** Retención de auditoría en días. En ATLAS la purga está ACTIVA por defecto (minimización de datos). */
  auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS ?? 90),
};
