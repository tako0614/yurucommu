output "worker_name" {
  description = "Portable product ModuleWorker name."
  value       = takoform_module_worker.product.name
}

output "dispatcher_worker_name" {
  description = "Private ModuleWorker name; it has no WorkerEndpoint."
  value       = takoform_module_worker.dispatcher.name
}

output "launch_url" {
  description = "Ordinary public URL allocated for the product Worker."
  value       = takoform_worker_endpoint.product.url
}

output "api_url" {
  description = "Primary Yurucommu social API endpoint."
  value       = "${trimsuffix(takoform_worker_endpoint.product.url, "/")}/api"
}

output "takoform_resource_ids" {
  description = "Portable Resource identities created by this source-only Actor candidate."
  value = {
    worker                     = takoform_module_worker.product.uid
    worker_bundle              = takoform_worker_bundle.product.uid
    worker_version             = takoform_worker_version.product.uid
    worker_deployment          = takoform_worker_deployment.product.uid
    worker_endpoint            = takoform_worker_endpoint.product.uid
    database                   = takoform_sqlite_database.product.uid
    migration_set              = takoform_sqlite_migration_set.product.uid
    migration_application      = takoform_sqlite_migration_application.product.uid
    kv                         = takoform_edge_kv_namespace.product.uid
    media                      = takoform_edge_object_bucket.media.uid
    delivery                   = takoform_at_least_once_queue.delivery.uid
    delivery_dlq               = takoform_at_least_once_queue.delivery_dlq.uid
    delivery_consumer          = takoform_queue_consumer.delivery.uid
    delivery_dlq_consumer      = takoform_queue_consumer.delivery_dlq.uid
    retention                  = takoform_worker_cron_trigger.retention.uid
    dispatcher_worker          = takoform_module_worker.dispatcher.uid
    dispatcher_database        = takoform_sqlite_database.dispatcher.uid
    dispatcher_migration_set   = takoform_sqlite_migration_set.dispatcher.uid
    dispatcher_migration_apply = takoform_sqlite_migration_application.dispatcher.uid
    dispatcher_bundle          = takoform_worker_bundle.dispatcher.uid
    dispatcher_version         = takoform_worker_version.dispatcher.uid
    dispatcher_deployment      = takoform_worker_deployment.dispatcher.uid
    call_signaling_actor       = takoform_actor_namespace.call_signaling.uid
    realtime_stream_actor      = takoform_actor_namespace.realtime_stream.uid
  }
}
