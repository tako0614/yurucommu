output "worker_name" {
  description = "Portable EdgeWorker resource name."
  value       = var.project_name
}

output "launch_url" {
  description = "Canonical public URL allocated by the selected Takoform host."
  value       = data.takoform_interface.worker_http.resource_uri
}

output "api_url" {
  description = "Primary Yurucommu social API endpoint."
  value       = data.takoform_interface.worker_http.resource_uri != null ? "${trimsuffix(data.takoform_interface.worker_http.resource_uri, "/")}/api" : null
}

output "takoform_resource_ids" {
  description = "Canonical portable Resource identities created for this Yurucommu instance."
  value = {
    worker       = takoform_edge_worker.worker.id
    database     = takoform_relational_database.database.id
    media        = takoform_object_bucket.media.id
    kv           = takoform_key_value_store.kv.id
    delivery     = takoform_queue.delivery.id
    delivery_dlq = takoform_queue.delivery_dlq.id
    retention    = takoform_schedule.retention.id
  }
}
