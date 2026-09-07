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
- **Redis** por Direct VPC egress (red `default`). Terraform provisiona **Memorystore**, que es lo
  correcto en producción: gestionado, con respaldos y opción de alta disponibilidad. El despliegue
  del **piloto** usa en cambio un Redis sobre una VM `e2-micro` (`atlas-redis`, us-east1-b, **sin IP
  pública**), porque Memorystore parte en 1 GiB por ~USD 35/mes y el uso real son unos pocos MB —
  cuadruplicaba la factura del resto del piloto. Detalles de esa variante:
  - Firewall `atlas-redis-desde-subred`: 6379 solo desde `10.142.0.0/20`, que es de donde sale
    Cloud Run con Direct VPC egress. SSH únicamente por IAP (`atlas-redis-ssh-iap`).
  - La contraseña vive en Secret Manager (`atlas-redis-password`) y la VM la lee al arrancar con su
    propia identidad, que no puede leer ningún otro secreto. **Nunca** viaja en los metadatos de la
    instancia, que los ve cualquiera con permiso de lectura sobre Compute.
  - La imagen se baja de `mirror.gcr.io` por acceso privado a Google: sin IP pública ni Cloud NAT.
  - Contrapartida aceptada: sin alta disponibilidad ni respaldos gestionados. Hay snapshots RDB a
    disco, así que un reinicio de la VM no borra el estado, pero la pérdida de la zona sí.
  - Para escalar a Memorystore: cambiar el secreto `atlas-redis-url` por su endpoint y redesplegar.

## 2b. Migraciones y currículo en producción (Cloud Run Jobs)

La aplicación **no migra al arrancar** y su imagen no lleva `migrations/`: es un bundle sin
`node_modules`. Eso dejaba la migración de producción como un paso manual desde un notebook con un
túnel a Cloud SQL, que obliga a autorizar una IP doméstica en la instancia. Para no depender de eso
hay una imagen aparte ([`Dockerfile.tareas`](../Dockerfile.tareas)) que corre como job **dentro** del
proyecto, hablando con Cloud SQL por el conector: sin IP pública autorizada y con el mismo secreto
que usa el servicio.

Cuatro jobs, todos re-ejecutables. En PowerShell el continuador es `` ` `` y **`"$IMG:v4"` no
funciona**: PowerShell lee `$IMG:` como variable con ámbito y manda el argumento vacío. Usar
`"${IMG}:v4"`.

```bash
IMG=us-east1-docker.pkg.dev/postgrados-ua/atlas/atlas-tareas
SA=768793961060-compute@developer.gserviceaccount.com
SQL=postgrados-ua:us-east1:atlas-demo
COMUN="--region us-east1 --service-account $SA --set-cloudsql-instances $SQL \
       --set-secrets DATABASE_URL=atlas-database-url:latest --max-retries 0 --task-timeout 10m"

gcloud builds submit --config cloudbuild.tareas.yaml --substitutions=_TAG=v4

# Job 1 — migraciones (es el CMD por omisión de la imagen)
gcloud run jobs create atlas-migrar --image $IMG:v4 $COMUN
gcloud run jobs execute atlas-migrar --region us-east1 --wait

# Job 2 — carga del currículo (idempotente; con --dry-run simula y hace rollback)
gcloud run jobs create atlas-curriculo --image $IMG:v4 $COMUN \
  --command node --args="scripts/cargar-curriculo.mjs,--archivar-otros"
gcloud run jobs execute atlas-curriculo --region us-east1 --wait

# Job 3 — ingesta del material al RAG (además de la base, necesita GEMINI_API_KEY)
gcloud run jobs create atlas-rag --image $IMG:v4 $COMUN \
  --set-secrets DATABASE_URL=atlas-database-url:latest,GEMINI_API_KEY=atlas-gemini-api-key:latest \
  --command npx --args="tsx,scripts/ingerir-contenido.ts,contenido"
gcloud run jobs execute atlas-rag --region us-east1 --wait

# Job 4 — reporte de la cohorte (solo lectura, sin datos personales)
gcloud run jobs create atlas-reporte --image $IMG:v4 $COMUN \
  --command node --args="scripts/reporte-cohorte.mjs"
gcloud run jobs execute atlas-reporte --region us-east1 --wait

# La salida de cualquier job:
gcloud run jobs executions logs read \
  $(gcloud run jobs executions list --job atlas-reporte --region us-east1 --limit 1 --format='value(name)') \
  --region us-east1
```

**Orden importante:** migrar → desplegar el servicio → cargar el currículo. El código nuevo lee
columnas que la migración crea, así que desplegarlo antes deja el curso caído; y cargar el currículo
antes del deploy hace que el código viejo sirva contenidos que no sabe interpretar.

**Cargar el currículo NO indexa nada al RAG.** El job 2 escribe el curso, las lecciones y las
interacciones; el material que el tutor busca vive en `content_chunk` y lo escribe el job 3. Si se
omite, `buscar_contenido_curso` devuelve `encontrado: false` y el tutor responde —correctamente,
según el prompt— que el material no cubre la pregunta. **Los jobs 2 y 3 van juntos, siempre.**

**Antes del job 2, correr el job 4.** Cargar el currículo **archiva** los cursos anteriores, y
`estadoAcademico` solo mira el curso activo: quien esté a medio camino en un curso archivado queda
como *no inscrito* y arrancaría de cero en el nuevo (su avance queda en la base, pero inaccesible).
Con una cohorte en curso eso es una decisión sobre personas, no sobre esquema — el reporte dice a
cuántas afecta y en qué punto están.

Para actualizar el material curricular más adelante basta reconstruir la imagen y volver a ejecutar
el job 2: reconcilia por códigos estables, así que nadie pierde su avance.

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
