output "worker_name" {
  description = "Portable ModuleWorker name."
  value       = takoform_module_worker.worker.name
}

output "launch_url" {
  description = "Canonical public URL attached through the app-owned WorkerCustomDomain resource."
  value       = var.app_url
}

output "api_url" {
  description = "Primary Yurucommu social API endpoint."
  value       = "${var.app_url}/api"
}

output "takoform_resource_ids" {
  description = "Portable Resource identities created for this Yurucommu instance."
  value = {
    worker                = takoform_module_worker.worker.uid
    worker_bundle         = takoform_worker_bundle.worker.uid
    worker_version        = takoform_worker_version.worker.uid
    worker_deployment     = takoform_worker_deployment.worker.uid
    worker_custom_domain  = takoform_worker_custom_domain.worker.uid
    database              = takoform_sqlite_database.database.uid
    migration_set         = takoform_sqlite_migration_set.schema.uid
    migration_application = takoform_sqlite_migration_application.schema.uid
    kv                    = takoform_edge_kv_namespace.kv.uid
    delivery              = takoform_at_least_once_queue.delivery.uid
    delivery_dlq          = takoform_at_least_once_queue.delivery_dlq.uid
    delivery_consumer     = takoform_queue_consumer.delivery.uid
    retention             = takoform_worker_cron_trigger.retention.uid
  }
}
