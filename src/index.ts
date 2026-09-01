import express from 'express';
import crypto from 'crypto';
import { config } from './config';
import { log } from './log';
import { runWithRequestContext } from './obs/requestContext';
import { metaVerify, verifyMetaSignature, metaWebhook } from './routes/whatsapp';
import { initDb, startRetentionSweep, dbEnabled } from './store/db';
import { snapshot, costoEstimadoUsd } from './obs/metrics';
import { dbResumenNegocio } from './store/metricasNegocio';
import { kvKind, kvVivo, once } from './store/kv';
import { verificarPorFolio } from './store/certificados';
import { requireDashboardToken } from './routes/guard';
import { rateLimit } from './routes/rateLimit';
import { planificar, despachar } from './reminders/motor';
import { messagingProvider } from './messaging';
import { verifyPubSubPush, pubsubTurnos } from './routes/pubsub';
import { correrOleada } from './convocatoria/motor';
import { cargarLote, resumen as resumenConvocatoria } from './store/invitaciones';
import { linkWaMe } from './convocatoria/qr';

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
// Verificación pública de un certificado: destino del QR impreso y del certUrl que LinkedIn exige
// para "Agregar a mi perfil". Es la ÚNICA ruta sin autenticación que consulta la base, así que va
// con el limitador estricto y devuelve lo mínimo: nombre, curso, fecha y folio.
//
// Exige folio Y código. El folio es secuencial (ATLAS-2026-0001, 0002, ...): resolver solo por folio
// dejaría recorrer la cohorte entera y extraer el nombre y el curso de cada estudiante. Ante
// cualquier discrepancia responde 404 sin distinguir "no existe" de "código incorrecto" — esa
// distinción sería, ella misma, un oráculo para enumerar.
const escapar = (t: string) =>
  String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const paginaVerificacion = (cuerpo: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Verificación de certificado — Universidad Autónoma de Chile</title>` +
  `<body style="font-family:system-ui,sans-serif;margin:0;padding:2rem;background:#f6f7f9;color:#1a1a1a">` +
  `<div style="max-width:34rem;margin:0 auto;background:#fff;border-radius:12px;padding:2rem;box-shadow:0 1px 3px rgba(0,0,0,.12)">` +
  cuerpo +
  `<p style="margin-top:2rem;font-size:.8rem;color:#667">Universidad Autónoma de Chile — ATLAS</p>` +
  `</div></body>`;

app.get('/verificar/:folio', strictLimiter, async (req, res) => {
  const cert = await verificarPorFolio(String(req.params.folio ?? ''), String(req.query.c ?? ''));
  // Nunca se indexa: es una página con el nombre de una persona.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!cert) {
    return res.status(404).send(paginaVerificacion(
      `<h1 style="margin:0 0 .5rem;font-size:1.3rem;color:#b3261e">Certificado no encontrado</h1>` +
      `<p style="color:#444">El enlace no corresponde a ningún certificado vigente. Verifica que esté completo, ` +
      `incluida la parte posterior al signo de interrogación.</p>`,
    ));
  }
  const fecha = cert.emitidoEn.toLocaleDateString('es-CL', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Santiago' });
  res.send(paginaVerificacion(
    `<p style="margin:0;color:#0f7b3f;font-weight:600">✓ Certificado válido</p>` +
    `<h1 style="margin:.4rem 0 1.2rem;font-size:1.6rem">${escapar(cert.nombre)}</h1>` +
    `<p style="margin:.2rem 0;color:#444">completó el curso</p>` +
    `<p style="margin:.2rem 0 1.2rem;font-size:1.15rem;font-weight:600;color:#273473">${escapar(cert.curso)}</p>` +
    `<p style="margin:.2rem 0;color:#444">${cert.minutos} minutos de formación certificada</p>` +
    `<p style="margin:.2rem 0;color:#444">Emitido el ${escapar(fecha)}</p>` +
    `<p style="margin:1.2rem 0 0;font-family:ui-monospace,monospace;color:#667">Folio ${escapar(cert.folio)}</p>`,
  ));
});

// Healthcheck. Comprueba Redis con un PING real, no solo el nombre del backend: informar "redis"
// mientras Redis está caído es peor que no tener healthcheck. Devuelve 503 si no responde.
app.get('/health', async (_req, res) => {
  const kvOk = await kvVivo();
  res.status(kvOk ? 200 : 503).json({
    ok: kvOk,
    kv: kvOk ? kvKind : `${kvKind}:sin-respuesta`,
    db: dbEnabled() ? 'postgres' : 'off',
    t: new Date().toISOString(),
  });
});

// Observabilidad (F13): técnicas (contadores/latencia/tokens vía Redis) + NEGOCIO (§20, desde las
// tablas reales) + costo LLM estimado. Protegido por header x-dashboard-token.
app.get('/metrics', requireDashboardToken, async (_req, res) => {
  const [s, negocio] = await Promise.all([snapshot(), dbResumenNegocio()]);
  res.json({
    ...s,
    kv: kvKind,
    db: dbEnabled() ? 'postgres' : 'off',
    costoLlmUsd: costoEstimadoUsd(s.counters, config.preciosLlm),
    negocio,
  });
});

// Webhook de WhatsApp Cloud API: GET = handshake de verificación (Meta lo llama al suscribir);
// POST = eventos, con verificación de firma. El procesamiento real llega en Fase 10.
app.get('/webhooks/whatsapp', metaVerify);
app.post('/webhooks/whatsapp', strictLimiter, verifyMetaSignature, metaWebhook);

// Worker Pub/Sub (F11): la push subscription entrega aquí los turnos que publicó el webhook.
// OIDC fail-closed (verifyPubSubPush); se procesa DENTRO del request (Pub/Sub espera el ack).
app.post('/pubsub/turnos', verifyPubSubPush, pubsubTurnos);

// Job de recordatorios (F9): lo dispara Cloud Scheduler (F11) cada ~15 min con el header del token.
// Lock distribuido para que réplicas/ejecuciones solapadas no dupliquen trabajo (el dedupe real
// está en Postgres: clave_dedupe UNIQUE — este lock solo evita trabajo redundante).
app.post('/jobs/recordatorios', requireDashboardToken, async (_req, res) => {
  if (!(await once('lock:job:recordatorios', 240))) {
    return res.status(202).json({ ok: true, skipped: 'job en curso' });
  }
  const plan = await planificar();
  const despacho = await despachar(messagingProvider());
  res.json({ ok: true, plan, despacho });
});

// ── Convocatoria de cohortes ──
// Carga del listado a invitar. Idempotente: recargar el mismo archivo no duplica ni reenvía.
app.post('/jobs/convocatoria/cargar', requireDashboardToken, async (req, res) => {
  const body = req.body as { lote?: string; entradas?: { telefono: string; nombre?: string }[] };
  if (!Array.isArray(body?.entradas) || !body.entradas.length) {
    return res.status(400).json({ ok: false, error: 'falta `entradas`: [{telefono, nombre?}]' });
  }
  try {
    const r = await cargarLote(body.entradas, body.lote?.trim() || new Date().toISOString().slice(0, 10));
    res.json({ ok: true, ...r });
  } catch (e) {
    log.error('convocatoria: carga falló', { err: String(e) });
    res.status(503).json({ ok: false, error: String(e) });
  }
});

// Oleada de invitaciones. Lo dispara Cloud Scheduler; el lock evita que dos corridas se solapen
// (el reclamo atómico en Postgres es la garantía real de no pagar dos veces la misma plantilla).
app.post('/jobs/convocatoria', requireDashboardToken, async (_req, res) => {
  if (!(await once('lock:job:convocatoria', 240))) {
    return res.status(202).json({ ok: true, skipped: 'job en curso' });
  }
  try {
    const estado = await resumenConvocatoria();
    const r = await correrOleada(messagingProvider(), estado?.enviadasHoy ?? 0);
    res.json({ ok: true, ...r, estado });
  } catch (e) {
    log.error('convocatoria: oleada falló', { err: String(e) });
    res.status(503).json({ ok: false, error: String(e) });
  }
});

// Estado de la convocatoria + el enlace de entrada gratuita (para imprimir el QR).
app.get('/jobs/convocatoria', requireDashboardToken, async (_req, res) => {
  res.json({
    ok: true,
    activa: config.convocatoriaActiva,
    plantilla: config.convocatoriaTemplate || null,
    cupos: { porCorrida: config.convocatoriaMaxPorCorrida, porDia: config.convocatoriaMaxPorDia },
    enlaceEntrada: linkWaMe(config.waMeNumero, config.waMeTexto),
    estado: await resumenConvocatoria(),
  });
});

// Inicializa Postgres y el barrido de retención. Fail-fast en producción: sin la fuente de
// verdad (identidad, progreso) el servicio no debe atender tráfico.
initDb()
  .then(() => startRetentionSweep())
  .catch((e) => {
    log.error('initDb error', { err: String(e) });
    if (config.isProd) process.exit(1);
  });

app.listen(config.port, () =>
  log.info('ATLAS escuchando', { port: config.port, baseUrl: config.baseUrl || '(define BASE_URL)' }),
);
