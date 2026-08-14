terraform {
  required_version = ">= 1.5"

  required_providers {
    takoform = {
      source  = "registry.opentofu.org/tako0614/takoform"
      version = "= 2.1.1"
    }
  }
}

variable "project_name" {
  description = "Portable name for this Yurucommu installation."
  type        = string
  default     = "yurucommu"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

variable "takosumi_accounts_issuer_url" {
  description = "Optional Takosumi Accounts OIDC issuer URL."
  type        = string
  default     = ""
}

variable "takosumi_accounts_client_id" {
  description = "Optional Takosumi Accounts public OIDC client id."
  type        = string
  default     = ""
}

variable "allow_unpinned_owner_claim" {
  description = "Allow the first OIDC sign-in to claim the initial owner slot."
  type        = bool
  default     = true
}

locals {
  prefix             = var.project_name
  worker_bundle_path = "${path.module}/../../dist/yurucommu-worker.js"
  migration_root     = "${path.module}/../../dist/takoform-current-migrations"
  migration_files    = fileset(local.migration_root, "*.sql")
  has_accounts_oidc  = trimspace(var.takosumi_accounts_issuer_url) != "" && trimspace(var.takosumi_accounts_client_id) != ""
  worker_plain_values = merge(
    {
      DELIVERY_QUEUE_NAME = "${local.prefix}-delivery"
      DELIVERY_DLQ_NAME   = "${local.prefix}-delivery-dlq"
    },
    local.has_accounts_oidc ? {
      TAKOSUMI_ACCOUNTS_ISSUER_URL = trimspace(var.takosumi_accounts_issuer_url)
      TAKOSUMI_ACCOUNTS_CLIENT_ID  = trimspace(var.takosumi_accounts_client_id)
      ALLOW_UNPINNED_OWNER_CLAIM   = var.allow_unpinned_owner_claim ? "true" : "false"
    } : {},
  )
}

resource "takoform_sqlite_database" "database" {
  name = "${local.prefix}-db"
}

resource "takoform_sqlite_migration_set" "schema" {
  revision_owner = local.prefix

  files = [
    for relative_path in sort(local.migration_files) : {
      path         = relative_path
      media_type   = "application/sql"
      content_file = "${local.migration_root}/${relative_path}"
    }
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_sqlite_migration_application" "schema" {
  name          = "${local.prefix}-schema"
  database      = takoform_sqlite_database.database.name
  migration_set = takoform_sqlite_migration_set.schema.name
}

resource "takoform_edge_object_bucket" "media" {
  name = "${local.prefix}-media"
}

resource "takoform_edge_kv_namespace" "kv" {
  name = "${local.prefix}-kv"
}

resource "takoform_at_least_once_queue" "delivery" {
  name                      = "${local.prefix}-delivery"
  message_retention_seconds = 345600
  delivery_delay_seconds    = 0
}

resource "takoform_at_least_once_queue" "delivery_dlq" {
  name                      = "${local.prefix}-delivery-dlq"
  message_retention_seconds = 1209600
  delivery_delay_seconds    = 0
}

resource "takoform_module_worker" "worker" {
  name = local.prefix
}

resource "takoform_worker_bundle" "worker" {
  revision_owner = local.prefix
  main_module    = "yurucommu-worker.js"

  modules = [
    {
      name         = "yurucommu-worker.js"
      content_type = "application/javascript+module"
      content_file = local.worker_bundle_path
    },
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_version" "worker" {
  revision_owner          = local.prefix
  worker                  = takoform_module_worker.worker.name
  bundle                  = takoform_worker_bundle.worker.name
  handlers                = ["fetch", "queue", "scheduled"]
  vars_json               = jsonencode(local.worker_plain_values)
  required_sensitive_vars = ["ENCRYPTION_KEY"]

  kv_bindings = [
    {
      name        = "KV"
      target_name = takoform_edge_kv_namespace.kv.name
    },
  ]

  bucket_bindings = [
    {
      name        = "MEDIA"
      target_name = takoform_edge_object_bucket.media.name
    },
  ]

  sqlite_bindings = [
    {
      name        = "DB"
      target_name = takoform_sqlite_database.database.name
    },
  ]

  queue_producer_bindings = [
    {
      name        = "DELIVERY_QUEUE"
      target_name = takoform_at_least_once_queue.delivery.name
    },
    {
      name        = "DELIVERY_DLQ"
      target_name = takoform_at_least_once_queue.delivery_dlq.name
    },
  ]

  depends_on = [takoform_sqlite_migration_application.schema]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_deployment" "worker" {
  name   = "${local.prefix}-deployment"
  worker = takoform_module_worker.worker.name

  versions = [
    {
      worker_version = takoform_worker_version.worker.name
      weight         = 10000
    },
  ]
}

resource "takoform_worker_endpoint" "worker" {
  name   = "${local.prefix}-endpoint"
  worker = takoform_module_worker.worker.name

  depends_on = [takoform_worker_deployment.worker]
}

resource "takoform_queue_consumer" "delivery" {
  name                      = "${local.prefix}-delivery-consumer"
  queue                     = takoform_at_least_once_queue.delivery.name
  worker                    = takoform_module_worker.worker.name
  max_batch_size            = 10
  max_batch_timeout_seconds = 1
  max_retries               = 3
  retry_delay_seconds       = 60
  dead_letter_queue         = takoform_at_least_once_queue.delivery_dlq.name
  max_concurrency           = 4

  depends_on = [takoform_worker_deployment.worker]
}

resource "takoform_queue_consumer" "delivery_dlq" {
  name                      = "${local.prefix}-delivery-dlq-consumer"
  queue                     = takoform_at_least_once_queue.delivery_dlq.name
  worker                    = takoform_module_worker.worker.name
  max_batch_size            = 10
  max_batch_timeout_seconds = 60
  max_retries               = 1
  retry_delay_seconds       = 60
  max_concurrency           = 1

  depends_on = [takoform_worker_deployment.worker]
}

resource "takoform_worker_cron_trigger" "retention" {
  name   = "${local.prefix}-retention"
  worker = takoform_module_worker.worker.name
  cron   = "0 * * * *"

  depends_on = [takoform_worker_deployment.worker]
}

output "worker_name" {
  value = takoform_module_worker.worker.name
}

output "launch_url" {
  value = takoform_worker_endpoint.worker.url
}

output "api_url" {
  value = "${trimsuffix(takoform_worker_endpoint.worker.url, "/")}/api"
}

output "takoform_resource_ids" {
  value = {
    worker                = takoform_module_worker.worker.uid
    worker_bundle         = takoform_worker_bundle.worker.uid
    worker_version        = takoform_worker_version.worker.uid
    worker_deployment     = takoform_worker_deployment.worker.uid
    worker_endpoint       = takoform_worker_endpoint.worker.uid
    database              = takoform_sqlite_database.database.uid
    migration_set         = takoform_sqlite_migration_set.schema.uid
    migration_application = takoform_sqlite_migration_application.schema.uid
    media                 = takoform_edge_object_bucket.media.uid
    kv                    = takoform_edge_kv_namespace.kv.uid
    delivery              = takoform_at_least_once_queue.delivery.uid
    delivery_dlq          = takoform_at_least_once_queue.delivery_dlq.uid
  }
}
