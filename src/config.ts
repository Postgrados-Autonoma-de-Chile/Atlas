import 'dotenv/config';
import { z } from 'zod';

// Configuración central de ATLAS, validada con zod al arrancar (Fase 2).
// - Un valor MALFORMADO (número inválido, enum desconocido) detiene el proceso en cualquier entorno:
//   se acabó el patrón heredado de "tragar el error y caer a un default silencioso".
// - En PRODUCCIÓN además es fail-fast por AUSENCIA: los secretos obligatorios deben existir.

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  BASE_URL: z.string().default(''),
  NODE_ENV: z.string().default(''),

  // ── LLM (Anthropic) ──
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  ANTHROPIC_CLASSIFIER: z.string().default('claude-haiku-4-5'),
  /** Esfuerzo de razonamiento por turno. 'low' es el punto de partida para chat de WhatsApp
   *  (latencia y costo); se re-evalúa con el harness pedagógico en Fase 6. */
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  ANTHROPIC_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  /** Precios USD/MTok para el costo estimado en /metrics (default: Sonnet 5). */
  LLM_USD_IN: z.coerce.number().min(0).default(2),
  LLM_USD_OUT: z.coerce.number().min(0).default(10),
  LLM_USD_CACHE_WRITE: z.coerce.number().min(0).default(2.5),
  LLM_USD_CACHE_READ: z.coerce.number().min(0).default(0.2),

  // ── STT (notas de voz) ──
  DEEPGRAM_API_KEY: z.string().default(''),
  DEEPGRAM_MODEL: z.string().default('nova-2'),

  // ── Persistencia ──
  REDIS_URL: z.string().default(''),
  DATABASE_URL: z.string().default(''),
  /** 'true' valida el certificado del servidor; 'no-verify' solo para legado (F12). */
  PGSSL: z.enum(['true', 'false', 'no-verify']).default('false'),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),

  // ── WhatsApp Cloud API (Meta) ──
  META_VERIFY_TOKEN: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  /** 'meta' = Cloud API directo · 'chattigo' = BSP Chattigo · '' = envío desactivado. */
  WA_PROVIDER: z.enum(['meta', 'chattigo', '']).default(''),
  WA_CLOUD_PHONE_NUMBER_ID: z.string().default(''),
  WA_CLOUD_TOKEN: z.string().default(''),
  WA_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),

  // ── BSP Chattigo (alternativa a Cloud API directo) ──
  /** Base de la API, SIN barra final. Chattigo no publica las URLs de sus ambientes: hay que
   *  pedírselas (son distintas en desarrollo y producción). */
  CHATTIGO_BASE_URL: z.string().default(''),
  CHATTIGO_USER: z.string().default(''),
  CHATTIGO_PASS: z.string().default(''),
  /** Número de la cuenta en Chattigo (campo `did`), en formato internacional SIN '+'. */
  CHATTIGO_DID: z.string().default(''),
  /** Campaña a la que pertenece el bot (campo `idCampaign`). */
  CHATTIGO_ID_CAMPAIGN: z.coerce.number().int().nonnegative().default(0),
  /** Nombre con el que el bot se identifica en los mensajes salientes (campo `botName`). */
  CHATTIGO_BOT_NAME: z.string().default('ATLAS'),
  /** Base del servicio de PLANTILLAS (HSM). Es OTRO host que el de la API del bot. */
  CHATTIGO_HSM_BASE_URL: z.string().default('https://login.chattigo.com/message'),
  /** Namespace de plantillas del Business Manager. Obligatorio para enviar HSM. */
  CHATTIGO_NAMESPACE: z.string().default(''),
  /**
   * Secreto compartido para autenticar el webhook ENTRANTE.
   *
   * Chattigo NO firma sus webhooks: la documentación solo describe un POST a la URL del cliente que
   * debe responder 200. Sin esto, cualquiera que descubra la ruta puede hacerse pasar por un
   * estudiante, alterar su progreso o disparar la emisión de un certificado. Se exige por header
   * (x-atlas-token) o, si Chattigo no permite headers personalizados, en la propia ruta.
   */
  CHATTIGO_WEBHOOK_TOKEN: z.string().default(''),

  // ── Seguridad / observabilidad ──
  DASHBOARD_TOKEN: z.string().default(''),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
  /** Clave AES-256-GCM (64 hex) para PII en reposo. Obligatoria en producción (F12). */
  TOKEN_ENC_KEY: z.string().regex(/^([0-9a-fA-F]{64})?$/, 'debe ser 64 caracteres hex (32 bytes)').default(''),
  /** F12: los guards y verificaciones de firma son FAIL-CLOSED por defecto en todos los entornos.
   *  Solo con DEV_FAIL_OPEN=true (y nunca en producción) se permite operar sin secretos en local. */
  DEV_FAIL_OPEN: z.enum(['true', 'false']).default('false'),

  // ── Límites ──
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_STRICT: z.coerce.number().int().positive().default(240),
  MAX_CONCURRENT_TURNS: z.coerce.number().int().positive().default(8),

  // ── Memoria conversacional (la académica vive en Postgres, F3-4) ──
  MEMORY_TTL_HOURS: z.coerce.number().int().positive().default(48),
  MEMORY_MAX_TURNS: z.coerce.number().int().positive().default(24),

  // ── Pub/Sub (F11: split webhook/worker). Vacío = despacho in-process (dev / piloto 1 servicio) ──
  /** Ruta completa del topic: projects/<proyecto>/topics/atlas-turnos */
  PUBSUB_TOPIC: z.string().regex(/^(projects\/[^/]+\/topics\/[^/]+)?$/).default(''),
  /** Endpoint regional recomendado con ordering (p. ej. https://us-east1-pubsub.googleapis.com). */
  PUBSUB_ENDPOINT: z.string().url().default('https://pubsub.googleapis.com'),
  /** Service account que firma el OIDC del push (fail-closed sin ella). */
  PUBSUB_PUSH_SA: z.string().default(''),
  PUBSUB_PUSH_AUDIENCE: z.string().default(''),

  // ── Correo (F8: certificados y códigos de verificación) — SMTP genérico ──
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  /** Remitente, p. ej. "ATLAS UAutónoma <atlas@uautonoma.cl>". Sin host/from → correos omitidos (dev). */
  SMTP_FROM: z.string().default(''),

  // ── Recordatorios (F9) ──
  /** Nombre de la plantilla utility APROBADA por Meta para recordatorios fuera de ventana 24h. */
  WA_TEMPLATE_RECORDATORIO: z.string().default(''),
  WA_TEMPLATE_LANG: z.string().default('es'),
  /** Días de inactividad antes de recordar (y ventana del dedupe: máx. 1 recordatorio cada N días). */
  REMINDER_DIAS_INACTIVIDAD: z.coerce.number().int().positive().default(3),
  /** Tope de recordatorios sin nueva actividad del estudiante (luego se deja de insistir). */
  REMINDER_MAX_SIN_ACTIVIDAD: z.coerce.number().int().positive().default(3),

  // ── Convocatoria de cohortes ──
  /** Apagada por defecto: encenderla gasta plantillas pagadas y consume el tramo de Meta. */
  CONVOCATORIA_ACTIVA: z.enum(['true', 'false']).default('false'),
  /** Plantilla de invitación APROBADA por Meta. Sin ella no se envía nada aunque esté activa. */
  CONVOCATORIA_TEMPLATE: z.string().default(''),
  /** Cupo por oleada (el job corre por Cloud Scheduler) y por día (tramo de Meta). */
  CONVOCATORIA_MAX_POR_CORRIDA: z.coerce.number().int().positive().default(100),
  CONVOCATORIA_MAX_POR_DIA: z.coerce.number().int().positive().default(500),
  /** Reintentos por invitación fallida. Un ok:false del proveedor significa que NO envió, así que
   *  reintentar no arriesga pagar dos veces; el tope evita insistir contra un número inexistente. */
  CONVOCATORIA_MAX_INTENTOS: z.coerce.number().int().positive().default(2),
  /** Número del tutor en formato libre: el enlace wa.me se arma con sus dígitos. */
  WA_ME_NUMERO: z.string().default(''),
  WA_ME_TEXTO: z.string().default('Hola, quiero inscribirme en el curso de IA'),

  // ── RAG (F5): embeddings Gemini + pgvector ──
  GEMINI_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  /** Dimensiones Matryoshka del embedding; debe calzar con vector(N) de la migración 0005. */
  EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
  /** Similitud coseno mínima para considerar un chunk relevante (bajo esto → "no está en el material"). */
  RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.55),
  RAG_TOP_K: z.coerce.number().int().positive().max(20).default(6),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const detalle = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ');
  throw new Error(`Configuración inválida — corrige las variables de entorno: ${detalle}`);
}
const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

// Fail-fast por ausencia en producción (fail-closed: sin esto, los guards rechazarían en runtime,
// pero es mejor no arrancar un servicio a medias).
if (isProd) {
  const obligatorias: Record<string, string> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    REDIS_URL: env.REDIS_URL,
    DATABASE_URL: env.DATABASE_URL,
    META_VERIFY_TOKEN: env.META_VERIFY_TOKEN,
    META_APP_SECRET: env.META_APP_SECRET,
    DASHBOARD_TOKEN: env.DASHBOARD_TOKEN,
    TOKEN_ENC_KEY: env.TOKEN_ENC_KEY, // F12: sin clave no hay PII en reposo cifrada → no se arranca
    WA_CLOUD_PHONE_NUMBER_ID: env.WA_CLOUD_PHONE_NUMBER_ID,
    WA_CLOUD_TOKEN: env.WA_CLOUD_TOKEN,
  };
  const faltan = Object.entries(obligatorias).filter(([, v]) => !v).map(([k]) => k);
  if (faltan.length) throw new Error(`Producción sin variables obligatorias: ${faltan.join(', ')}`);
  if (env.DEV_FAIL_OPEN === 'true') throw new Error('DEV_FAIL_OPEN=true está prohibido en producción');
}

export const config = {
  isProd,
  port: env.PORT,
  /** URL pública del servicio (Cloud Run o túnel local), sin slash final. */
  baseUrl: env.BASE_URL.replace(/\/$/, ''),

  anthropicApiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL,
  classifierModel: env.ANTHROPIC_CLASSIFIER,
  llmEffort: env.ANTHROPIC_EFFORT,
  anthropicTimeoutMs: env.ANTHROPIC_TIMEOUT_MS,
  anthropicMaxRetries: env.ANTHROPIC_MAX_RETRIES,
  preciosLlm: {
    inUsd: env.LLM_USD_IN,
    outUsd: env.LLM_USD_OUT,
    cacheWriteUsd: env.LLM_USD_CACHE_WRITE,
    cacheReadUsd: env.LLM_USD_CACHE_READ,
  },

  deepgramApiKey: env.DEEPGRAM_API_KEY,
  deepgramModel: env.DEEPGRAM_MODEL,

  redisUrl: env.REDIS_URL,
  databaseUrl: env.DATABASE_URL,
  pgSsl: env.PGSSL,
  pgPoolMax: env.PGPOOL_MAX,

  metaVerifyToken: env.META_VERIFY_TOKEN,
  metaAppSecret: env.META_APP_SECRET,
  waProvider: env.WA_PROVIDER,
  waCloudPhoneNumberId: env.WA_CLOUD_PHONE_NUMBER_ID,
  waCloudToken: env.WA_CLOUD_TOKEN,
  waGraphVersion: env.WA_GRAPH_VERSION,

  chattigoBaseUrl: env.CHATTIGO_BASE_URL.replace(/\/$/, ''),
  chattigoUser: env.CHATTIGO_USER,
  chattigoPass: env.CHATTIGO_PASS,
  chattigoDid: env.CHATTIGO_DID,
  chattigoIdCampaign: env.CHATTIGO_ID_CAMPAIGN,
  chattigoBotName: env.CHATTIGO_BOT_NAME,
  chattigoHsmBaseUrl: env.CHATTIGO_HSM_BASE_URL.replace(/\/$/, ''),
  chattigoNamespace: env.CHATTIGO_NAMESPACE,
  chattigoWebhookToken: env.CHATTIGO_WEBHOOK_TOKEN,

  dashboardToken: env.DASHBOARD_TOKEN,
  auditRetentionDays: env.AUDIT_RETENTION_DAYS,
  tokenEncKey: env.TOKEN_ENC_KEY,
  devFailOpen: env.DEV_FAIL_OPEN === 'true',

  rateLimitMax: env.RATE_LIMIT_MAX,
  rateLimitStrict: env.RATE_LIMIT_STRICT,
  maxConcurrentTurns: env.MAX_CONCURRENT_TURNS,

  memoryTtlHours: env.MEMORY_TTL_HOURS,
  memoryMaxTurns: env.MEMORY_MAX_TURNS,

  pubsubTopic: env.PUBSUB_TOPIC,
  pubsubEndpoint: env.PUBSUB_ENDPOINT,
  pubsubPushSa: env.PUBSUB_PUSH_SA,
  pubsubPushAudience: env.PUBSUB_PUSH_AUDIENCE,

  smtpHost: env.SMTP_HOST,
  smtpPort: env.SMTP_PORT,
  smtpUser: env.SMTP_USER,
  smtpPass: env.SMTP_PASS,
  smtpFrom: env.SMTP_FROM,

  waTemplateRecordatorio: env.WA_TEMPLATE_RECORDATORIO,
  waTemplateLang: env.WA_TEMPLATE_LANG,
  reminderDiasInactividad: env.REMINDER_DIAS_INACTIVIDAD,
  reminderMaxSinActividad: env.REMINDER_MAX_SIN_ACTIVIDAD,

  convocatoriaActiva: env.CONVOCATORIA_ACTIVA === 'true',
  convocatoriaTemplate: env.CONVOCATORIA_TEMPLATE,
  convocatoriaMaxPorCorrida: env.CONVOCATORIA_MAX_POR_CORRIDA,
  convocatoriaMaxPorDia: env.CONVOCATORIA_MAX_POR_DIA,
  convocatoriaMaxIntentos: env.CONVOCATORIA_MAX_INTENTOS,
  waMeNumero: env.WA_ME_NUMERO,
  waMeTexto: env.WA_ME_TEXTO,

  geminiApiKey: env.GEMINI_API_KEY,
  embeddingModel: env.EMBEDDING_MODEL,
  embeddingDim: env.EMBEDDING_DIM,
  ragMinScore: env.RAG_MIN_SCORE,
  ragTopK: env.RAG_TOP_K,
};
