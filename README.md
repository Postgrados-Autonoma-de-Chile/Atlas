# ATLAS — Tutor educativo de IA por WhatsApp

Proyecto de la **Universidad Autónoma de Chile**: un tutor de IA que acompaña a estudiantes de cursos de formación por WhatsApp — entrega clases, resuelve dudas con RAG sobre el material del curso, evalúa para enseñar (selección múltiple y V/F con retroalimentación pedagógica), recuerda el progreso y gestiona la certificación.

> **Estado: en transformación (Fase 1 completada).** Este repo nació como un chatbot comercial omnicanal sobre Bitrix24; la lógica de ventas fue eliminada y el núcleo conversacional se conserva. La auditoría completa y el roadmap de 16 fases están en el documento de Fase 0 del proyecto.

## Stack

Node.js ≥22 · TypeScript (tsx) · Express · Anthropic Claude · Redis (memoria conversacional, locks, idempotencia) · PostgreSQL (auditoría hoy; fuente de verdad académica desde la Fase 3) · destino: GCP (Cloud Run + Pub/Sub + Cloud SQL/pgvector).

## Desarrollo

```bash
npm install
cp .env.example .env   # completa ANTHROPIC_API_KEY
npm run typecheck
npm test               # suite hermética (sin Redis/Postgres reales)
npm run dev
```

Endpoints actuales: `GET /health` · `GET /metrics` (header `x-dashboard-token`) · `GET|POST /webhooks/whatsapp` (handshake + firma verificada; receptor real en Fase 10).

## Estructura

```
src/
├── index.ts            # bootstrap Express (webhook, health, metrics)
├── config.ts           # configuración central desde env
├── ai/                 # motor: agentLoop (Claude + tools), memoria, cliente, STT
├── core/channel.ts     # perfiles por canal (patrón núcleo + adaptadores)
├── routes/             # webhook Meta/WhatsApp, guards, rate limit
├── whatsapp/           # envío de plantillas Cloud API (proveedor meta|custom→BSP)
├── campaign/calendar.ts# ventanas horarias TZ Chile (base de recordatorios, F9)
├── store/              # kv (Redis/memoria), Postgres, cifrado en reposo
├── obs/                # métricas, auditoría, redacción PII, correlación
└── util/               # semáforo, locks (in-process y distribuido), timing-safe
docs/
├── specs/              # especificaciones extraídas del sistema anterior
└── DECOMISO-VENTAS.md  # checklist operacional de baja del sistema comercial
```

## Fases

0 Auditoría ✔ · 1 Limpieza ✔ · 2 Arquitectura ✔ · 3 Identidad ✔ · **4 Cursos y progreso ✔ · 5 RAG ✔ · 6 Tutor ✔ · 7 Evaluaciones ✔ · 9 Recordatorios ✔** · 8 Certificación · 10 WhatsApp Cloud API (10a ✔) · 11 GCP · 12 Seguridad · 13 Observabilidad · 14 Performance · 15 Escalabilidad

El curso del piloto vive en `contenido/` (Nivel Inicial — Alfabetización ciudadana en IA, 3 propuestas × 8 microcápsulas + producto de cierre) y su estructura está sembrada por las migraciones `0003`/`0004`. Las transcripciones de las microcápsulas (para el RAG de F5) se cargan como `content_item` cuando existan.
