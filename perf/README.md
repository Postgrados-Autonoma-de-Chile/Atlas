# Pruebas de carga (Fase 14)

Regla §26.17 de ATLAS: ninguna afirmación de capacidad sin prueba. Este directorio contiene el
instrumento; se ejecuta contra **staging** (nunca producción, nunca la WABA real — los teléfonos
del pool son sintéticos `5698xxxxxxx` y no generan envíos si `WA_PROVIDER` está vacío).

## Dos modos de staging

| Modo | Config de staging | Qué valida | Costo |
|---|---|---|---|
| **Tubería** | `WA_PROVIDER=` vacío y `ANTHROPIC_API_KEY` de staging vacía o falsa | webhook → firma → dedupe → Pub/Sub → worker → pipeline completo con fallback del motor (sin LLM real) | ~$0 |
| **Realista** | credenciales reales | E2E incluyendo RAG + LLM | escenario A ≈ 2.400 turnos ≈ **US$3-8**; escenario B ≈ 50.000 turnos ≈ **US$60-170** (Sonnet 5 c/caché) — revisar `costoLlmUsd` en /metrics |

## Ejecución

```bash
# 0) snapshot de métricas
BASE_URL=https://staging DASHBOARD_TOKEN=... npx tsx perf/verificar.ts antes

# 1) humo (siempre primero)
k6 run perf/carga.js -e BASE_URL=https://staging -e META_APP_SECRET=... -e ESCENARIO=smoke

# 2) escenario A (gate del piloto: ~1.000 concurrentes) — luego B (~10.000)
k6 run perf/carga.js -e BASE_URL=... -e META_APP_SECRET=... -e ESCENARIO=A

# 3) invariantes (N = iteraciones únicas que reporta k6)
BASE_URL=... DASHBOARD_TOKEN=... npx tsx perf/verificar.ts despues --enviados=N

# 4) dedupe bajo reintentos de Meta (cada wamid se envía DOS veces; inbound debe subir solo N)
k6 run perf/carga.js -e ... -e ESCENARIO=C
npx tsx perf/verificar.ts despues --enviados=N --con-duplicados
```

## Umbrales codificados (k6 falla si no se cumplen)

- ACK del webhook: p95 < 500 ms, p99 < 1,5 s (el turno pesado vive en el worker — si el p95 del
  webhook crece, el split Pub/Sub no está operando).
- `http_req_failed` < 0,5 % · checks ≥ 99,5 %.
- Invariantes post-corrida (verificar.ts): `inbound` == únicos enviados (sin pérdida NI duplicación,
  también bajo reintentos), errores sin crecer, `reply ≤ inbound`.

## Qué mirar además (docs/OBSERVABILIDAD.md)

Backlog de Pub/Sub (`oldest_unacked_message_age`), DLQ == 0, p95 del worker, memoria/CPU de las
instancias, conexiones de Cloud SQL, y `costoLlmUsd`.

## Escalera de escala (auditoría §13)

Aprobar A antes del piloto; aprobar B antes de producción inicial. B→C (50k concurrentes) y
siguientes NO son solo infra: requieren contrato enterprise del LLM y throughput/números
adicionales de WhatsApp — negociación comercial primero, k6 después.
