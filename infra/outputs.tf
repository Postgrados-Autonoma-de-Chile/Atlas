output "webhook_url" {
  description = "URL a suscribir en Meta: <webhook_url>/webhooks/whatsapp"
  value       = google_cloud_run_v2_service.webhook.uri
}

output "worker_url" {
  value = google_cloud_run_v2_service.worker.uri
}

output "sql_connection_name" {
  description = "Para el Cloud SQL Auth Proxy local (migraciones/ingesta): <proyecto>:<región>:atlas-pg"
  value       = google_sql_database_instance.pg.connection_name
}

output "redis_host" {
  value = google_redis_instance.kv.host
}

output "artifact_repo" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.atlas.repository_id}"
}
