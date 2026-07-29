output "worker_name" {
  description = "Portable EdgeWorker resource name."
  value       = var.project_name
}

output "launch_url" {
  description = "Canonical public URL allocated by the selected Takoform host."
  value       = try(takoform_http_service.worker.outputs["url"], null)
}

output "api_url" {
  description = "Primary Yurucommu social API endpoint."
  value       = try("${trimsuffix(takoform_http_service.worker.outputs["url"], "/")}/api", null)
}

output "takoform_resource_ids" {
  description = "Canonical portable Resource identities created for this Yurucommu instance."
  value = {
    worker       = takoform_http_service.worker.id
    database     = takoform_relational_database.database.id
    media        = takoform_object_bucket.media.id
    kv           = takoform_key_value_store.kv.id
    delivery     = takoform_queue.delivery.id
    delivery_dlq = takoform_queue.delivery_dlq.id
    retention    = takoform_schedule.retention.id
  }
}
