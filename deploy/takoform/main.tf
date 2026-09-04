terraform {
  required_version = ">= 1.5"

  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = "= 4.0.0"
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

# Which binding shape the Host will hand this Worker. The lane names the
# BINDING SHAPE, not the tool that published the Worker, so it cannot be
# inferred from the fact that this is a Takoform module: the same configuration
# lands on either kind of Host.
#
#   portable (default)    a wrapper host — a self-hosted or managed Takoserver
#                         — replaces env before the module sees it and each
#                         binding arrives as the facade its Interface names:
#                         edge.sql, edge.kv, edge.objects, edge.queue.
#   cloudflare            a raw-binding Takoform Host projects Cloudflare
#                         bindings — a D1Database, a KV namespace, an R2
#                         bucket, and Queues. The root module is the separate
#                         direct-Cloudflare adapter; use this override only
#                         when a Takoform Host explicitly supplies raw
#                         bindings.
#
# The Worker refuses to start when this disagrees with the bindings that
# actually arrive, rather than handing a facade to a D1 client.
variable "runtime_lane" {
  description = "Binding shape this deployment's Host projects: portable (edge.* facades, the default) or cloudflare (raw Cloudflare bindings)."
  type        = string
  default     = "portable"

  validation {
    condition     = contains(["cloudflare", "portable"], var.runtime_lane)
    error_message = "runtime_lane must be either \"cloudflare\" or \"portable\"."
  }
}

locals {
  prefix              = var.project_name
  worker_bundle_path  = "${path.module}/.generated/yurucommu-worker.js"
  migration_root      = "${path.module}/migrations/sql"
  migration_files     = fileset(local.migration_root, "*.sql")
  delivery_queue_name = "${local.prefix}-delivery"
  delivery_dlq_name   = "${local.prefix}-delivery-dlq"

  # DELIVERY_QUEUE_NAME / DELIVERY_DLQ_NAME are not decoration: the engine's
  # queue handler routes a batch by comparing `batch.queue` against these two
  # values, and falls through to "unknown queue" when neither matches. Its
  # built-in defaults are the queue names of an install left at the default
  # `project_name`, so any instance that renamed the Capsule would accept every
  # delivery message and drain none of them. They are derived from the same
  # locals the queues are named from, so renaming the Capsule cannot separate
  # the two.
  worker_plain_values = {
    YURUCOMMU_RUNTIME_LANE = var.runtime_lane
    DELIVERY_QUEUE_NAME    = local.delivery_queue_name
    DELIVERY_DLQ_NAME      = local.delivery_dlq_name
  }
}

resource "takoform_module_worker" "worker" {
  name = local.prefix

  depends_on = [
    takoform_sqlite_database.database,
    takoform_edge_kv_namespace.kv,
    takoform_edge_object_bucket.media,
    takoform_at_least_once_queue.delivery,
    takoform_at_least_once_queue.delivery_dlq,
  ]
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

resource "takoform_edge_kv_namespace" "kv" {
  name = "${local.prefix}-kv"
}

# The worker consumes MEDIA through the edge.objects API (an R2-style bucket
# binding), so the bucket is a portable ObjectBucket Form rather than an
# external S3 service the host would have to supply out of band.
resource "takoform_edge_object_bucket" "media" {
  name = "${local.prefix}-media"
}

resource "takoform_at_least_once_queue" "delivery" {
  name                      = local.delivery_queue_name
  message_retention_seconds = 345600
  delivery_delay_seconds    = 0
}

resource "takoform_at_least_once_queue" "delivery_dlq" {
  name                      = local.delivery_dlq_name
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

  bucket_bindings = [
    {
      name        = "MEDIA"
      target_name = takoform_edge_object_bucket.media.name
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

# The dead-letter queue needs a consumer of its own. The Worker's queue handler
# treats a DLQ batch as repair work — it recovers messages the main queue
# dead-lettered after exhausting their retries, so an unconsumed DLQ is not an
# idle backlog but silently dropped federation deliveries and stranded push
# outbox rows. Concurrency is 1: repairs touch the same durable rows the main
# lane failed on, and there is no throughput to win here.
resource "takoform_queue_consumer" "delivery_dlq" {
  name                      = "${local.prefix}-delivery-dlq-consumer"
  queue                     = takoform_at_least_once_queue.delivery_dlq.name
  worker                    = takoform_module_worker.worker.name
  max_batch_size            = 10
  max_batch_timeout_seconds = 60
  max_retries               = 1
  retry_delay_seconds       = 300
  max_concurrency           = 1

  depends_on = [takoform_worker_deployment.worker]
}

resource "takoform_worker_cron_trigger" "retention" {
  name   = "${local.prefix}-retention"
  worker = takoform_module_worker.worker.name
  cron   = "0 * * * *"

  depends_on = [takoform_worker_deployment.worker]
}
