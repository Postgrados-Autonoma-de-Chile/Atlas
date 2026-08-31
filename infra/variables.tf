# ATLAS — variables del IaC mínimo del piloto (Fase 11).

variable "project_id" {
  description = "Proyecto GCP"
  type        = string
}

variable "region" {
  description = "Región principal (us-east1 recomendada por la auditoría; southamerica-west1 si se exige residencia)"
  type        = string
  default     = "us-east1"
}

variable "imagen" {
  description = "Imagen del servicio (Artifact Registry), p. ej. us-east1-docker.pkg.dev/PROY/atlas/atlas:TAG"
  type        = string
}

variable "db_tier" {
  description = "Tier de Cloud SQL (piloto: db-g1-small; producción inicial: db-custom-2-8)"
  type        = string
  default     = "db-g1-small"
}

variable "redis_gb" {
  type    = number
  default = 1
}

variable "min_instances_webhook" {
  description = "Min instances del webhook (>=1 evita cold start vs reintentos de Meta)"
  type        = number
  default     = 1
}

# Secretos que la app espera desde Secret Manager. Se crean VACÍOS: los valores se cargan con
# `gcloud secrets versions add` (nunca por Terraform → nunca en el state).
variable "secretos" {
  type = list(string)
  default = [
    "ANTHROPIC_API_KEY", "META_VERIFY_TOKEN", "META_APP_SECRET",
    "WA_CLOUD_PHONE_NUMBER_ID", "WA_CLOUD_TOKEN", "WA_TEMPLATE_RECORDATORIO",
    "DASHBOARD_TOKEN", "TOKEN_ENC_KEY", "GEMINI_API_KEY",
    "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM",
  ]
}
