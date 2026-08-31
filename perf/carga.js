// ATLAS — prueba de carga del webhook (Fase 14). Genera webhooks de WhatsApp Cloud API FIRMADOS
// (HMAC-SHA256 real) con wamids únicos sobre un pool de estudiantes sintéticos.
//
// Uso:
//   k6 run perf/carga.js -e BASE_URL=https://staging... -e META_APP_SECRET=... -e ESCENARIO=smoke|A|B|C
//
// Escenarios (auditoría §13: usuarios concurrentes ≈ msg/s × 120):
//   smoke : 1 msg/s × 30 s — humo post-deploy.
//   A     : 8 msg/s × 5 min  ≈ 1.000 usuarios concurrentes (gate de piloto).
//   B     : 83 msg/s × 10 min ≈ 10.000 concurrentes (producción inicial).
//   C     : 10 msg/s × 3 min, cada envelope ENVIADO DOS VECES (reintentos de Meta):
//           el invariante es que el dedupe cuente cada wamid UNA vez (verificar con perf/verificar.ts).
//
// Umbral del webhook: el ACK debe ser rápido SIEMPRE (el turno pesado vive en el worker vía Pub/Sub).
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

const BASE = __ENV.BASE_URL;
const SECRET = __ENV.META_APP_SECRET;
if (!BASE || !SECRET) throw new Error('Define BASE_URL y META_APP_SECRET');

const ESCENARIOS = {
  smoke: { rate: 1, duration: '30s', vus: 5 },
  A: { rate: 8, duration: '5m', vus: 40 },
  B: { rate: 83, duration: '10m', vus: 400 },
  C: { rate: 10, duration: '3m', vus: 60 },
};
const cfg = ESCENARIOS[__ENV.ESCENARIO || 'smoke'];
if (!cfg) throw new Error('ESCENARIO debe ser smoke|A|B|C');
const MODO_DUPLICADOS = (__ENV.ESCENARIO || '') === 'C';

export const options = {
  scenarios: {
    principal: {
      executor: 'constant-arrival-rate',
      rate: cfg.rate,
      timeUnit: '1s',
      duration: cfg.duration,
      preAllocatedVUs: cfg.vus,
      maxVUs: cfg.vus * 3,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1500'], // ACK del webhook, no el turno LLM
    http_req_failed: ['rate<0.005'],
    checks: ['rate>0.995'],
  },
};

const POOL = 1000; // estudiantes sintéticos distintos (prefijo reservado para no chocar con reales)
const telefono = (i) => `5698${String(1000000 + (i % POOL)).slice(-7)}`;

function envelopeMensaje(wamid, from, texto) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_PERF',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '56900000000', phone_number_id: 'PERF' },
          contacts: [{ profile: { name: 'Perf' }, wa_id: from }],
          messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
        },
      }],
    }],
  };
}

function envelopeStatus(wamid, to) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          statuses: [{ id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to }],
        },
      }],
    }],
  };
}

const TEXTOS = [
  'hola', 'quiero continuar el curso', '¿qué es la inteligencia artificial?', 'sí',
  '¿cómo hago una buena pregunta a una ia?', 'quiz', 'ya vi la microcápsula', '¿cuál es mi avance?',
];

function postFirmado(body) {
  const raw = JSON.stringify(body);
  const firma = 'sha256=' + crypto.hmac('sha256', SECRET, raw, 'hex');
  return http.post(`${BASE}/webhooks/whatsapp`, raw, {
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma },
  });
}

export default function () {
  const from = telefono(__VU * 7919 + __ITER);
  const wamid = `wamid.PERF-${__VU}-${__ITER}-${Date.now()}`;
  const esStatus = (__ITER % 10) === 9; // ~10% del tráfico son webhooks de estado
  const body = esStatus
    ? envelopeStatus(wamid, from)
    : envelopeMensaje(wamid, from, TEXTOS[__ITER % TEXTOS.length]);

  const r1 = postFirmado(body);
  check(r1, { 'ack 200': (r) => r.status === 200 });

  if (MODO_DUPLICADOS && !esStatus) {
    const r2 = postFirmado(body); // reintento de Meta: MISMO wamid
    check(r2, { 'reintento tambien 200': (r) => r.status === 200 });
  }
}
