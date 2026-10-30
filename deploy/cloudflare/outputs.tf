output "launch_url" {
  description = "Public URL of this Yurucommu instance."
  value       = local.launch_url
}

output "api_url" {
  description = "Primary Yurucommu social API endpoint."
  value       = "${local.launch_url}/api"
}

output "worker_name" {
  description = "Cloudflare Worker name."
  value       = cloudflare_workers_script.worker.script_name
}

output "cloudflare_resource_ids" {
  description = "Cloudflare identities created for this instance."
  value = {
    worker           = cloudflare_workers_script.worker.id
    d1_database      = cloudflare_d1_database.database.id
    d1_database_name = cloudflare_d1_database.database.name
    kv_namespace     = cloudflare_workers_kv_namespace.kv.id
    r2_bucket        = cloudflare_r2_bucket.media.name
    delivery_queue   = cloudflare_queue.delivery.queue_name
    delivery_dlq     = cloudflare_queue.delivery_dlq.queue_name
    custom_domain    = try(cloudflare_workers_custom_domain.app[0].hostname, null)
  }
}
