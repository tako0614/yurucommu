terraform {
  required_version = ">= 1.5"

  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = "= 3.0.0"
    }
  }
}

variable "project_name" {
  description = "Portable resource-name prefix for this Yurucommu instance."
  type        = string
  default     = "yurucommu"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

variable "app_url" {
  description = "Canonical public HTTPS origin for this Yurucommu instance."
  type        = string

  validation {
    condition = trimspace(var.app_url) == var.app_url && (can(regex(
      "^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$",
      var.app_url,
    )) || can(regex("^https://\\[[0-9A-Fa-f:.]+\\](:[0-9]{1,5})?$", var.app_url)))
    error_message = "app_url must be an exact HTTPS origin without a path, query, fragment, userinfo, or trailing slash."
  }
}

locals {
  prefix                    = var.project_name
  worker_bundle_path        = "${path.module}/.generated/yurucommu-worker.js"
  migration_root            = "${path.module}/migrations/sql"
  migration_files           = fileset(local.migration_root, "*.sql")
  resource_name_max_length  = 63
  resource_name_hash_length = 8
  resource_name_suffixes = {
    database     = "db"
    kv           = "kv"
    delivery     = "delivery"
    delivery_dlq = "delivery-dlq"
    retention    = "retention"
  }
  resource_names = merge(
    { app = local.prefix },
    {
      for key, suffix in local.resource_name_suffixes :
      key => length("${local.prefix}-${suffix}") <= local.resource_name_max_length
      ? "${local.prefix}-${suffix}"
      : format(
        "%s-%s-%s",
        substr(local.prefix, 0, local.resource_name_max_length - length(suffix) - local.resource_name_hash_length - 2),
        suffix,
        substr(sha256("${local.prefix}-${suffix}"), 0, local.resource_name_hash_length),
      )
    },
  )
  worker_plain_values = {
    APP_URL                = trimspace(var.app_url)
    DELIVERY_QUEUE_NAME    = local.resource_names.delivery
    DELIVERY_DLQ_NAME      = local.resource_names.delivery_dlq
    YURUCOMMU_RUNTIME_LANE = "takoform-v1"
  }
}

resource "takoform_module_worker" "worker" {
  name = local.resource_names.app

  depends_on = [
    takoform_sqlite_database.database,
    takoform_edge_kv_namespace.kv,
    takoform_at_least_once_queue.delivery,
    takoform_at_least_once_queue.delivery_dlq,
  ]
}

resource "takoform_sqlite_database" "database" {
  name = local.resource_names.database
}

resource "takoform_sqlite_migration_set" "schema" {
  revision_owner = local.resource_names.app

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
  name          = "${local.resource_names.app}-schema"
  database      = takoform_sqlite_database.database.name
  migration_set = takoform_sqlite_migration_set.schema.name
}

resource "takoform_edge_kv_namespace" "kv" {
  name = local.resource_names.kv
}

resource "takoform_at_least_once_queue" "delivery" {
  name                      = local.resource_names.delivery
  message_retention_seconds = 345600
  delivery_delay_seconds    = 0
}

resource "takoform_at_least_once_queue" "delivery_dlq" {
  name                      = local.resource_names.delivery_dlq
  message_retention_seconds = 1209600
  delivery_delay_seconds    = 0
}

resource "takoform_worker_bundle" "worker" {
  revision_owner = takoform_module_worker.worker.name
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
  revision_owner = takoform_module_worker.worker.name
  worker         = takoform_module_worker.worker.name
  bundle         = takoform_worker_bundle.worker.name
  handlers       = ["fetch", "queue", "scheduled"]
  vars_json      = jsonencode(local.worker_plain_values)
  required_sensitive_vars = [
    "ENCRYPTION_KEY",
    "TAKOSUMI_ACCOUNTS_ISSUER_URL",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID",
    "TAKOSUMI_ACCOUNTS_OWNER_SUB",
    "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
  ]

  kv_bindings = [
    {
      name        = "KV"
      target_name = takoform_edge_kv_namespace.kv.name
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

  external_services = [
    {
      name     = "MEDIA"
      protocol = "com.amazonaws.s3"
      required = true
    },
  ]

  depends_on = [takoform_sqlite_migration_application.schema]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_deployment" "worker" {
  name   = "${local.resource_names.app}-deployment"
  worker = takoform_module_worker.worker.name

  versions = [
    {
      worker_version = takoform_worker_version.worker.name
      weight         = 10000
    },
  ]
}

resource "takoform_worker_endpoint" "worker" {
  name   = "${local.resource_names.app}-endpoint"
  worker = takoform_module_worker.worker.name

  depends_on = [takoform_worker_deployment.worker]
}

resource "takoform_queue_consumer" "delivery" {
  name                      = "${local.resource_names.app}-delivery-consumer"
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
  name                      = "${local.resource_names.app}-delivery-dlq-consumer"
  queue                     = takoform_at_least_once_queue.delivery_dlq.name
  worker                    = takoform_module_worker.worker.name
  max_batch_size            = 10
  max_batch_timeout_seconds = 60
  max_retries               = 1
  retry_delay_seconds       = 60
  max_concurrency           = 4

  depends_on = [takoform_worker_deployment.worker]
}

resource "takoform_worker_cron_trigger" "retention" {
  name   = "${local.resource_names.app}-retention"
  worker = takoform_module_worker.worker.name
  cron   = "0 * * * *"

  depends_on = [takoform_worker_deployment.worker]
}
