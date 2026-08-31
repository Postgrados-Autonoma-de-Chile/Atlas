# Runbook de despliegue GCP (Fase 11)

IaC mínimo del piloto en `infra/` (Terraform). Región recomendada: `us-east1` (auditoría §12);
`southamerica-west1` solo si la Universidad exige residencia de datos (+20-40 % de costo).

## 1. Primera vez

```bash
# 1) Infraestructura (pide project_id e imagen; para el primer apply usa cualquier imagen pública
#    de relleno, p. ej. gcr.io/cloudrun/hello — el deploy real la reemplaza):
cd infra
terraform init
terraform apply -var project_id=MI_PROYECTO -var imagen=gcr.io/cloudrun/hello

# 2) Cargar los SECRETOS (valores reales, NUNCA por Terraform → nunca en el state):
printf '%s' 'sk-ant-...' | gcloud secrets versions add atlas-anthropic-api-key --data-file=-
# ...repetir para: atlas-meta-verify-token, atlas-meta-app-secret, atlas-wa-cloud-phone-number-id,
#    atlas-wa-cloud-token, atlas-dashboard-token, atlas-token-enc-key (64 hex), atlas-gemini-api-key,
#    atlas-smtp-* y atlas-wa-template-recordatorio. atlas-database-url ya la creó Terraform.

# 3) Completar el header del Scheduler con el MISMO valor de atlas-dashboard-token:
#    infra/main.tf → google_cloud_scheduler_job.recordatorios → headers.x-dashboard-token, y re-apply.

# 4) Migraciones + seed + ingesta del RAG (local, vía Cloud SQL Auth Proxy):
cloud-sql-proxy $(terraform output -raw sql_connection_name) &   # abre 127.0.0.1:5432
DATABASE_URL=postgresql://atlas:PASS@127.0.0.1:5432/atlas npm run migrate
DATABASE_URL=... GEMINI_API_KEY=... npx tsx scripts/ingerir-contenido.ts descripciones
# (la contraseña: gcloud secrets versions access latest --secret=atlas-database-url)

# 5) Deploy de la imagen real: push a main con las Variables del repo configuradas
#    (GCP_PROJECT_ID, GCP_REGION, GCP_WIF_PROVIDER, GCP_DEPLOY_SA) → .github/workflows/deploy.yml.
#    El deploy solo corre con typecheck+tests+build verdes (gate).

# 6) Suscribir el webhook en Meta (app de WhatsApp → Configuration → Webhooks):
#    URL:   $(terraform output -raw webhook_url)/webhooks/whatsapp
#    Token: el valor de atlas-meta-verify-token · Campo: messages
```

## 2. Topología

- **atlas-webhook** (público; la firma HMAC de Meta es la barrera): verifica y PUBLICA cada turno a
  Pub/Sub (`atlas-turnos`, ordering por estudiante). `min_instances=1` contra el cold start vs
  reintentos de Meta. Si el publish falla, degrada a despacho local (no se pierde el turno).
- **atlas-worker** (solo identidades OIDC): consume el push en `/pubsub/turnos` (verificación
  fail-closed de la SA), corre el pipeline completo (registro→evaluación→certificación→tutor) y
  recibe el Cloud Scheduler en `/jobs/recordatorios` cada 15 min.
- **DLQ** `atlas-turnos-dlq` (5 intentos): inspeccionar con la suscripción `atlas-turnos-dlq-inspeccion`.
- **Cloud SQL** por connector (socket `/cloudsql/...`, sin `no-verify`); backups + PITR activos.
- **Memorystore** por Direct VPC egress (red `default`).

## 3. Validación post-deploy

```bash
WEBHOOK=$(cd infra && terraform output -raw webhook_url)
curl -s $WEBHOOK/health                                    # {ok:true, kv:"redis", db:"postgres"}
curl -s "$WEBHOOK/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=TOKEN&hub.challenge=ping"  # → ping
# WhatsApp real: escribir al número → registro → curso → quiz → certificado.
# Recordatorios: gcloud scheduler jobs run atlas-recordatorios --location REGION
# Harness pedagógico (gate de piloto): npm run eval:tutor con las credenciales productivas.
```

## 4. Pendientes conocidos post-piloto (ver docs/SEGURIDAD.md y auditoría F15)

- Staging con número de pruebas de Meta; alertas (F13); pruebas de carga k6 (F14).
- Escala: pooler (pgbouncer)/réplicas, ruteo de modelos, contratos enterprise LLM/Meta (F15).
