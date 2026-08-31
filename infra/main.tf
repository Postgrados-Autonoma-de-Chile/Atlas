# ATLAS — IaC mínimo del piloto (Fase 11). Deliberadamente pequeño: los servicios administrados
# hacen el trabajo (auditoría §12) y lo que falte se endurece con datos del piloto (F14/F15).
# Runbook completo en docs/DEPLOY.md.

terraform {
  required_version = ">= 1.7"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── APIs ──────────────────────────────────────────────────────────────────────
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com",
    "pubsub.googleapis.com", "cloudscheduler.googleapis.com", "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com", "compute.googleapis.com", "iam.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ── Artifact Registry ────────────────────────────────────────────────────────
resource "google_artifact_registry_repository" "atlas" {
  repository_id = "atlas"
  format        = "DOCKER"
  location      = var.region
  depends_on    = [google_project_service.apis]
}

# ── Secret Manager (secretos vacíos; valores por gcloud, jamás en el state) ──
resource "google_secret_manager_secret" "s" {
  for_each  = toset(var.secretos)
  secret_id = "atlas-${lower(replace(each.value, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# ── Cloud SQL (PostgreSQL 16 + pgvector vía migración 0005) ──────────────────
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "pg" {
  name             = "atlas-pg"
  database_version = "POSTGRES_16"
  region           = var.region
  settings {
    tier = var.db_tier
    ip_configuration {
      ipv4_enabled = true # el runtime usa el Cloud SQL connector (socket) — sin IP autorizada
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true # PITR: Postgres es la fuente de verdad académica (F12)
    }
  }
  deletion_protection = true
  depends_on          = [google_project_service.apis]
}

resource "google_sql_database" "atlas" {
  name     = "atlas"
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "atlas" {
  name     = "atlas"
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "atlas-database-url"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  # Conexión por el socket del Cloud SQL connector que Cloud Run monta en /cloudsql (F12: sin no-verify).
  secret_data = "postgresql://atlas:${random_password.db.result}@localhost/atlas?host=/cloudsql/${google_sql_database_instance.pg.connection_name}"
}

# ── Memorystore Redis (memoria conversacional, locks, dedupe, rate-limit) ────
resource "google_redis_instance" "kv" {
  name           = "atlas-kv"
  tier           = "BASIC"
  memory_size_gb = var.redis_gb
  region         = var.region
  depends_on     = [google_project_service.apis]
}

# ── Service accounts ─────────────────────────────────────────────────────────
resource "google_service_account" "runtime" {
  account_id   = "atlas-runtime"
  display_name = "ATLAS runtime (webhook + worker)"
}

resource "google_service_account" "push" {
  account_id   = "atlas-pubsub-push"
  display_name = "ATLAS Pub/Sub push (OIDC del worker)"
}

resource "google_service_account" "scheduler" {
  account_id   = "atlas-scheduler"
  display_name = "ATLAS Cloud Scheduler"
}

resource "google_project_iam_member" "runtime_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "runtime_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_secrets" {
  for_each  = google_secret_manager_secret.s
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_dburl" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# ── Pub/Sub: topic con ORDERING + DLQ ────────────────────────────────────────
resource "google_pubsub_topic" "turnos" {
  name = "atlas-turnos"
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "turnos_dlq" {
  name = "atlas-turnos-dlq"
}

resource "google_pubsub_subscription" "turnos_push" {
  name                    = "atlas-turnos-push"
  topic                   = google_pubsub_topic.turnos.id
  ack_deadline_seconds    = 60
  enable_message_ordering = true # + orderingKey por estudiante en el publisher
  push_config {
    push_endpoint = "${google_cloud_run_v2_service.worker.uri}/pubsub/turnos"
    oidc_token {
      service_account_email = google_service_account.push.email
    }
  }
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.turnos_dlq.id
    max_delivery_attempts = 5
  }
  retry_policy {
    minimum_backoff = "5s"
    maximum_backoff = "120s"
  }
}

resource "google_pubsub_subscription" "dlq_keep" {
  name  = "atlas-turnos-dlq-inspeccion"
  topic = google_pubsub_topic.turnos_dlq.id
}

# ── Cloud Run: entorno común ─────────────────────────────────────────────────
locals {
  env_secretos = merge(
    { for k in var.secretos : k => "atlas-${lower(replace(k, "_", "-"))}" },
    { DATABASE_URL = google_secret_manager_secret.database_url.secret_id },
  )
  env_planos = {
    NODE_ENV        = "production"
    REDIS_URL       = "redis://${google_redis_instance.kv.host}:${google_redis_instance.kv.port}"
    PGSSL           = "false" # el socket del connector ya viene cifrado/autenticado
    PUBSUB_TOPIC    = google_pubsub_topic.turnos.id
    PUBSUB_ENDPOINT = "https://${var.region}-pubsub.googleapis.com"
    PUBSUB_PUSH_SA  = google_service_account.push.email
  }
}

# ── Cloud Run: WORKER (procesa turnos; recibe el push y el scheduler) ────────
resource "google_cloud_run_v2_service" "worker" {
  name     = "atlas-worker"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 1 # timers de retención + latencia de primer turno
      max_instance_count = 10
    }
    vpc_access {
      network_interfaces {
        network = "default"
      }
      egress = "PRIVATE_RANGES_ONLY" # Direct VPC egress → Memorystore
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.pg.connection_name]
      }
    }
    containers {
      image = var.imagen
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      dynamic "env" {
        for_each = local.env_planos
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.env_secretos
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# ── Cloud Run: WEBHOOK (verifica firma y publica; min>=1 vs reintentos de Meta) ─
resource "google_cloud_run_v2_service" "webhook" {
  name     = "atlas-webhook"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = var.min_instances_webhook
      max_instance_count = 10
    }
    vpc_access {
      network_interfaces {
        network = "default"
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.pg.connection_name]
      }
    }
    containers {
      image = var.imagen
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      dynamic "env" {
        for_each = local.env_planos
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.env_secretos
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# Meta llama al webhook sin identidad GCP: invocación pública (la firma HMAC es la barrera — F10a).
resource "google_cloud_run_v2_service_iam_member" "webhook_publico" {
  name     = google_cloud_run_v2_service.webhook.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# El worker SOLO acepta identidades: la SA del push y la del scheduler (+ verificación OIDC en la app).
resource "google_cloud_run_v2_service_iam_member" "worker_push" {
  name     = google_cloud_run_v2_service.worker.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.push.email}"
}

resource "google_cloud_run_v2_service_iam_member" "worker_scheduler" {
  name     = google_cloud_run_v2_service.worker.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# ── Cloud Scheduler → /jobs/recordatorios cada 15 min (agenda fina la decide el motor) ─
resource "google_cloud_scheduler_job" "recordatorios" {
  name      = "atlas-recordatorios"
  region    = var.region
  schedule  = "*/15 13-24 * * 1-6" # UTC ≈ 10:00-20:59 Chile; el motor re-verifica ventana y feriados
  time_zone = "Etc/UTC"
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.worker.uri}/jobs/recordatorios"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = google_cloud_run_v2_service.worker.uri
    }
    headers = { "x-dashboard-token" = "" } # completar tras cargar DASHBOARD_TOKEN (ver docs/DEPLOY.md)
  }
  depends_on = [google_project_service.apis]
}
