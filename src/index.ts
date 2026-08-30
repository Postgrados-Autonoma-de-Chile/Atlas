import express from 'express';
import crypto from 'crypto';
import { config } from './config';
import { log } from './log';
import { runWithRequestContext } from './obs/requestContext';
import { metaVerify, verifyMetaSignature, metaWebhook } from './routes/whatsapp';
import { initDb, startRetentionSweep, dbEnabled } from './store/db';
import { snapshot } from './obs/metrics';
import { kvKind } from './store/kv';
import { requireDashboardToken } from './routes/guard';
import { rateLimit } from './routes/rateLimit';

// ATLAS — tutor educativo por WhatsApp (Universidad Autónoma de Chile).
// Fase 1: núcleo mínimo tras la limpieza del bot de ventas. El servicio expone:
//   - /health y /metrics (observabilidad)
//   - /webhooks/whatsapp (handshake + firma verificada; receptor real en Fase 10)
// En Fase 11 este proceso se divide en dos servicios Cloud Run (webhook y worker) unidos por Pub/Sub.

const app = express();
app.set('trust proxy', 1); // detrás del proxy del PaaS → req.ip refleja X-Forwarded-For (revisar en Cloud Run, F11)

// Captura el body crudo (verify) además de parsearlo: verifyMetaSignature recalcula el HMAC
// exactamente sobre los bytes que Meta firmó.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));

// Correlación: asigna un requestId por petición y lo propaga (AsyncLocalStorage) a todos los logs.
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  runWithRequestContext({ requestId }, () => next());
});

// Rate limiting (por IP, distribuido vía Redis): global + estricto para el webhook.
const RL_WINDOW = 60_000;
const globalLimiter = rateLimit({ name: 'global', windowMs: RL_WINDOW, max: config.rateLimitMax });
const strictLimiter = rateLimit({ name: 'strict', windowMs: RL_WINDOW, max: config.rateLimitStrict });
app.use(globalLimiter);

app.get('/', (_req, res) =>
  res.send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem">` +
      `ATLAS — tutor educativo por WhatsApp (en construcción). El servicio opera en segundo plano.` +
      `</body>`,
  ),
);
app.get('/health', (_req, res) =>
  res.json({ ok: true, kv: kvKind, db: dbEnabled() ? 'postgres' : 'off', t: new Date().toISOString() }),
);

// Observabilidad: métricas agregadas (JSON), protegidas por header x-dashboard-token.
app.get('/metrics', requireDashboardToken, async (_req, res) => {
  const s = await snapshot();
  res.json({ ...s, kv: kvKind, db: dbEnabled() ? 'postgres' : 'off' });
});

// Webhook de WhatsApp Cloud API: GET = handshake de verificación (Meta lo llama al suscribir);
// POST = eventos, con verificación de firma. El procesamiento real llega en Fase 10.
app.get('/webhooks/whatsapp', metaVerify);
app.post('/webhooks/whatsapp', strictLimiter, verifyMetaSignature, metaWebhook);

// Inicializa Postgres (auditoría) y el barrido de retención.
initDb()
  .then(() => startRetentionSweep())
  .catch((e) => log.error('initDb error', { err: String(e) }));

app.listen(config.port, () =>
  log.info('ATLAS escuchando', { port: config.port, baseUrl: config.baseUrl || '(define BASE_URL)' }),
);
