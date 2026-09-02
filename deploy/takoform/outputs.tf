output "worker_name" {
  description = "Portable ModuleWorker name."
  value       = takoform_module_worker.worker.name
}

output "launch_url" {
  description = "Ordinary public URL allocated by WorkerEndpoint."
  value       = takoform_worker_endpoint.worker.url
}

output "api_url" {
  description = "Primary Yurucommu social API endpoint."
  value       = "${trimsuffix(takoform_worker_endpoint.worker.url, "/")}/api"
}

output "takoform_resource_ids" {
  description = "Portable Resource identities created for this Yurucommu instance."
  value = {
    worker                = takoform_module_worker.worker.uid
    worker_bundle         = takoform_worker_bundle.worker.uid
    worker_version        = takoform_worker_version.worker.uid
    worker_deployment     = takoform_worker_deployment.worker.uid
    worker_endpoint       = takoform_worker_endpoint.worker.uid
    database              = takoform_sqlite_database.database.uid
    migration_set         = takoform_sqlite_migration_set.schema.uid
    migration_application = takoform_sqlite_migration_application.schema.uid
    kv                    = takoform_edge_kv_namespace.kv.uid
    media                 = takoform_edge_object_bucket.media.uid
    delivery              = takoform_at_least_once_queue.delivery.uid
    delivery_dlq          = takoform_at_least_once_queue.delivery_dlq.uid
    delivery_consumer     = takoform_queue_consumer.delivery.uid
    delivery_dlq_consumer = takoform_queue_consumer.delivery_dlq.uid
    retention             = takoform_worker_cron_trigger.retention.uid
  }
}
