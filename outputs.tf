output "worker_name" {
  description = "Cloudflare Worker name used when enable_cloudflare_worker_script is true."
  value       = local.worker_name
}

output "worker_managed_by_opentofu" {
  description = "True when the Worker script, bindings, assets, queue consumers, and workers.dev enablement are managed by OpenTofu."
  value       = local.cloudflare_worker_enabled
}

output "cloudflare_worker_script_id" {
  description = "OpenTofu-managed Cloudflare Worker script ID, or null when enable_cloudflare_worker_script is false."
  value       = try(cloudflare_workers_script.worker[0].id, null)
}

output "cloudflare_worker_route_id" {
  description = "OpenTofu-managed Cloudflare Worker route ID, or null when cloudflare_route_zone_id/cloudflare_route_pattern are not set."
  value       = try(cloudflare_workers_route.worker[0].id, null)
}

output "launch_url" {
  description = "Public URL for the published Yurucommu instance, when the Capsule has enough hostname input to derive it."
  value       = local.launch_url
}

output "api_url" {
  description = "Primary Yurucommu social API endpoint."
  value       = local.launch_url != null ? "${trimsuffix(local.launch_url, "/")}/api" : null
}

output "cloudflare_account_id" {
  description = "Cloudflare account id used for the Yurucommu backing resources, or null when Cloudflare resource provisioning is disabled."
  value       = local.cloudflare_resources_enabled ? var.cloudflare_account_id : null
}

output "cloudflare_d1_database_id" {
  description = "D1 database id for the DB binding, or null when Cloudflare resource provisioning is disabled."
  value       = try(cloudflare_d1_database.database[0].id, null)
}

output "cloudflare_d1_database_name" {
  description = "D1 database name for the DB binding."
  value       = local.d1_database_name
}

output "cloudflare_r2_bucket_name" {
  description = "R2 bucket name for the MEDIA binding."
  value       = local.r2_media_bucket
}

output "cloudflare_kv_namespace_id" {
  description = "Workers KV namespace id for the KV binding, or null when Cloudflare resource provisioning is disabled."
  value       = try(cloudflare_workers_kv_namespace.kv[0].id, null)
}

output "cloudflare_queue_names" {
  description = "Cloudflare Queue names for the delivery queue bindings."
  value = {
    delivery     = local.delivery_queue_name
    delivery_dlq = local.delivery_dlq_name
  }
}
