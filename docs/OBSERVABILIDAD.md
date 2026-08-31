# Observabilidad (Fase 13)

## Logs

En producción salen como **JSON estructurado por stdout** (Cloud Logging los parsea nativamente):
`severity` (INFO/WARNING/ERROR), `message`, `time`, más el contexto correlacionado `reqId` y
`dialogId` (teléfono **ya redactado** a `[tel]` — la redacción de PII es incondicional en prod, F12).
En desarrollo, texto de una línea. Forzable con `LOG_FORMAT=json|text`.

## Métricas — `GET /metrics` (header `x-dashboard-token`)

| Bloque | Contenido | Fuente |
|---|---|---|
| `counters` | inbound, reply, llm_calls, tool:*, wa:status:* (sent/delivered/read/failed), errors:*, pubsub:publicado, audit:*, tokens_in/out/cache_read/cache_write | Redis (agregado entre réplicas) |
| `llm` | latencia avg/p95 (muestra 500) | Redis |
| `costoLlmUsd` | costo estimado desde los tokens medidos × `LLM_USD_*` (default Sonnet 5, caché incluida) | cálculo |
| `negocio` | §20: personas (total/7d), inscripciones activas, cursos completados, lecciones (total/7d), quizzes (total/7d), % respuestas correctas, certificados por estado, recordatorios por estado | Postgres (tablas reales, nunca el audit_log) |

## Alertas recomendadas (Cloud Monitoring)

Crear tras el primer deploy; los umbrales del piloto se recalibran con datos reales (F14).

| # | Señal | Condición sugerida | Tipo |
|---|---|---|---|
| 1 | Uptime `GET /health` (webhook y worker) | 2 fallos seguidos | Uptime check |
| 2 | 5xx del webhook | > 1 % por 5 min | Métrica integrada de Cloud Run |
| 3 | Latencia de request del worker (p95) | > 30 s por 10 min (el turno LLM vive dentro del request push) | Cloud Run |
| 4 | **DLQ con mensajes** (`atlas-turnos-dlq`) | `num_undelivered_messages` > 0 | Pub/Sub |
| 5 | Backlog de turnos | `oldest_unacked_message_age` > 120 s | Pub/Sub |
| 6 | Fallos de entrega WhatsApp | log-based: `message="whatsapp: mensaje saliente falló"` > 5/h | Log-based metric |
| 7 | Publish caído (degradación a local) | log-based: `errors:pubsub_publish` en counters o `message=~"publish falló"` | Log-based metric |
| 8 | Recordatorios fallidos | log-based sobre `recordatorios:` WARN/ERROR, o `negocio.recordatorios.fallido` creciendo | Log-based / scrape |
| 9 | Certificados atascados | `negocio.certificados.emitido` > 0 sostenido (emitidos sin enviar → SMTP caído) | Scrape de /metrics |
| 10 | Severidad ERROR global | > 10/h en cualquiera de los dos servicios | Log-based metric |
| 11 | Presupuesto LLM | `costoLlmUsd` diario > presupuesto piloto (y presupuesto de facturación GCP aparte) | Scrape + Billing budget |
| 12 | Cloud SQL | storage > 80 %, conexiones > 80 % de max | Métricas integradas |
| 13 | Scheduler sin ejecutar | job `atlas-recordatorios` sin ejecución exitosa en 1 h dentro de la ventana | Scheduler/log-based |

Log-based metrics: Logging → Log-based metrics → Create (filtro por `severity` y `message`); luego
Monitoring → Alerting sobre esa métrica. El scrape de `/metrics` puede hacerse con un uptime check
autenticado o un job liviano hasta que haya Prometheus/Grafana (post-piloto).

## Criterios §25 y dónde medirlos

- Groundedness / cita de fuente / honestidad / calidad pedagógica → `npm run eval:tutor` (harness F6, reporte versionado en `eval/`).
- Latencia y tasa de errores → `llm.p95Ms`, counters `errors*`, métricas de Cloud Run.
- Tasa de finalización / evaluaciones / certificación → bloque `negocio`.
- Costo por estudiante ≈ `costoLlmUsd / negocio.personas` (más WhatsApp/GCP según auditoría §14).
