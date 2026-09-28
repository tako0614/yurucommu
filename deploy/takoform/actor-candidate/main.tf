terraform {
  required_version = ">= 1.5"

  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = "= 0.0.0-dev"
    }
  }
}

variable "project_name" {
  description = "Portable resource-name prefix for this source-only Actor candidate."
  type        = string
  default     = "yurucommu"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,38}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-40 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

# RTC stays opt-in. These values are non-secret configuration only; TURN and
# SFU credentials are requested by name through required_sensitive_vars below.
variable "rtc_ice_servers" {
  description = "Optional JSON ICE server array; do not put credentials in this value."
  type        = string
  default     = null
}

variable "rtc_turn_uris" {
  description = "Optional comma-separated TURN/TURNS URIs. Selecting TURN requests its secret separately."
  type        = string
  default     = null
}

variable "rtc_turn_ttl" {
  description = "Optional TURN ephemeral credential lifetime in seconds."
  type        = string
  default     = null
}

variable "rtc_sfu_adapter" {
  description = "Optional SFU adapter selector; unset or p2p keeps group calls on the default P2P path."
  type        = string
  default     = null
}

variable "rtc_sfu_url" {
  description = "Optional WHIP/WHEP SFU endpoint."
  type        = string
  default     = null
}

variable "rtc_sfu_app_id" {
  description = "Optional SFU application identifier, reserved for adapters that consume it."
  type        = string
  default     = null
}

locals {
  prefix                     = var.project_name
  product_worker_name        = local.prefix
  dispatcher_worker_name     = "${local.prefix}-call-dispatcher"
  product_bundle_path        = "${path.module}/.generated/yurucommu-worker.js"
  dispatcher_bundle_path     = "${path.module}/.generated/yurucommu-call-dispatcher.js"
  migration_root             = "${path.module}/../migrations/sql"
  migration_files            = fileset(local.migration_root, "*.sql")
  delivery_queue_name        = "${local.prefix}-delivery"
  delivery_dlq_name          = "${local.prefix}-delivery-dlq"
  rtc_ice_servers_configured = var.rtc_ice_servers == null ? false : trimspace(var.rtc_ice_servers) != ""
  rtc_turn_uris_configured   = var.rtc_turn_uris == null ? false : trimspace(var.rtc_turn_uris) != ""
  rtc_turn_ttl_configured    = var.rtc_turn_ttl == null ? false : trimspace(var.rtc_turn_ttl) != ""
  rtc_sfu_adapter_configured = var.rtc_sfu_adapter == null ? false : trimspace(var.rtc_sfu_adapter) != ""
  rtc_sfu_url_configured     = var.rtc_sfu_url == null ? false : trimspace(var.rtc_sfu_url) != ""
  rtc_sfu_app_id_configured  = var.rtc_sfu_app_id == null ? false : trimspace(var.rtc_sfu_app_id) != ""
  rtc_sfu_selected = local.rtc_sfu_adapter_configured ? (
    lower(trimspace(var.rtc_sfu_adapter)) != "p2p" && local.rtc_sfu_url_configured
  ) : false
  product_plain_values = {
    YURUCOMMU_RUNTIME_LANE = "portable"
    DELIVERY_QUEUE_NAME    = local.delivery_queue_name
    DELIVERY_DLQ_NAME      = local.delivery_dlq_name
  }
  dispatcher_plain_values = merge({
    YURUCOMMU_RUNTIME_LANE = "portable"
    },
    local.rtc_ice_servers_configured ? {
      YURUCOMMU_RTC_ICE_SERVERS = var.rtc_ice_servers
    } : {},
    local.rtc_turn_uris_configured ? {
      YURUCOMMU_RTC_TURN_URIS = var.rtc_turn_uris
    } : {},
    local.rtc_turn_ttl_configured ? {
      YURUCOMMU_RTC_TURN_TTL = var.rtc_turn_ttl
    } : {},
    local.rtc_sfu_adapter_configured ? {
      YURUCOMMU_RTC_SFU_ADAPTER = var.rtc_sfu_adapter
    } : {},
    local.rtc_sfu_url_configured ? {
      YURUCOMMU_RTC_SFU_URL = var.rtc_sfu_url
    } : {},
    local.rtc_sfu_app_id_configured ? {
      YURUCOMMU_RTC_SFU_APP_ID = var.rtc_sfu_app_id
  } : {})
  dispatcher_sensitive_names = concat(
    local.rtc_turn_uris_configured ? ["YURUCOMMU_RTC_TURN_SECRET"] : [],
    local.rtc_sfu_selected ? ["YURUCOMMU_RTC_SFU_TOKEN"] : [],
    local.rtc_sfu_selected && local.rtc_sfu_app_id_configured ? ["YURUCOMMU_RTC_SFU_APP_SECRET"] : [],
  )
}

# C: the public product Worker. Its Actor classes are served by the active C
# deployment; namespace identity can be allocated before that class is Ready.
resource "takoform_module_worker" "product" {
  name = local.product_worker_name
}

resource "takoform_sqlite_database" "product" {
  name = "${local.prefix}-db"
}

resource "takoform_sqlite_migration_set" "product" {
  revision_owner = local.product_worker_name
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

resource "takoform_sqlite_migration_application" "product" {
  name          = "${local.prefix}-schema"
  database      = takoform_sqlite_database.product.name
  migration_set = takoform_sqlite_migration_set.product.name
}

resource "takoform_edge_kv_namespace" "product" {
  name = "${local.prefix}-kv"
}

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

# N1/N2: native Actor identities attached to C. Their `.name`/`.uid` are
# available when allocated even while class readiness is still false.
resource "takoform_actor_namespace" "call_signaling" {
  name       = "${local.prefix}-call-signaling"
  worker     = takoform_module_worker.product.name
  class_name = "CallSignalingActor"
}

resource "takoform_actor_namespace" "realtime_stream" {
  name       = "${local.prefix}-realtime-stream"
  worker     = takoform_module_worker.product.name
  class_name = "RealtimeStreamActor"
}

# D: private Worker; deliberately has no WorkerEndpoint. Its only Actor
# capability is the N1 namespace used by the call dispatcher.
resource "takoform_module_worker" "dispatcher" {
  name = local.dispatcher_worker_name
}

resource "takoform_worker_bundle" "dispatcher" {
  revision_owner = takoform_module_worker.dispatcher.name
  main_module    = "yurucommu-call-dispatcher.js"

  modules = [
    {
      name         = "yurucommu-call-dispatcher.js"
      content_type = "application/javascript+module"
      content_file = local.dispatcher_bundle_path
    },
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_version" "dispatcher" {
  revision_owner          = takoform_module_worker.dispatcher.name
  worker                  = takoform_module_worker.dispatcher.name
  bundle                  = takoform_worker_bundle.dispatcher.name
  handlers                = ["fetch"]
  vars_json               = jsonencode(local.dispatcher_plain_values)
  required_sensitive_vars = local.dispatcher_sensitive_names

  sqlite_bindings = [
    {
      name        = "DB"
      target_name = takoform_sqlite_database.product.name
    },
  ]

  actor_bindings = [
    {
      name        = "CALL_SIGNALING"
      target_name = takoform_actor_namespace.call_signaling.name
    },
  ]

  depends_on = [takoform_sqlite_migration_application.product]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_deployment" "dispatcher" {
  name   = "${local.prefix}-call-dispatcher-deployment"
  worker = takoform_module_worker.dispatcher.name

  versions = [
    {
      worker_version = takoform_worker_version.dispatcher.name
      weight         = 10000
    },
  ]
}

resource "takoform_worker_bundle" "product" {
  revision_owner = takoform_module_worker.product.name
  main_module    = "yurucommu-worker.js"

  modules = [
    {
      name         = "yurucommu-worker.js"
      content_type = "application/javascript+module"
      content_file = local.product_bundle_path
    },
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_version" "product" {
  revision_owner = takoform_module_worker.product.name
  worker         = takoform_module_worker.product.name
  bundle         = takoform_worker_bundle.product.name
  handlers       = ["fetch", "queue", "scheduled"]
  vars_json      = jsonencode(local.product_plain_values)
  required_sensitive_vars = [
    "ENCRYPTION_KEY",
    "TAKOSUMI_ACCOUNTS_ISSUER_URL",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID",
    "TAKOSUMI_ACCOUNTS_OWNER_SUB",
  ]

  kv_bindings = [
    {
      name        = "KV"
      target_name = takoform_edge_kv_namespace.product.name
    },
  ]

  sqlite_bindings = [
    {
      name        = "DB"
      target_name = takoform_sqlite_database.product.name
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

  service_bindings = [
    {
      name        = "CALL_DISPATCHER"
      target_name = takoform_module_worker.dispatcher.name
    },
  ]

  actor_bindings = [
    {
      name        = "CALL_SIGNALING"
      target_name = takoform_actor_namespace.call_signaling.name
    },
    {
      name        = "REALTIME_STREAM"
      target_name = takoform_actor_namespace.realtime_stream.name
    },
  ]

  depends_on = [
    takoform_sqlite_migration_application.product,
    takoform_worker_deployment.dispatcher,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_deployment" "product" {
  name   = "${local.prefix}-deployment"
  worker = takoform_module_worker.product.name

  versions = [
    {
      worker_version = takoform_worker_version.product.name
      weight         = 10000
    },
  ]
}

resource "takoform_worker_endpoint" "product" {
  name   = "${local.prefix}-endpoint"
  worker = takoform_module_worker.product.name

  depends_on = [takoform_worker_deployment.product]
}

resource "takoform_queue_consumer" "delivery" {
  name                      = "${local.prefix}-delivery-consumer"
  queue                     = takoform_at_least_once_queue.delivery.name
  worker                    = takoform_module_worker.product.name
  max_batch_size            = 10
  max_batch_timeout_seconds = 1
  max_retries               = 3
  retry_delay_seconds       = 60
  dead_letter_queue         = takoform_at_least_once_queue.delivery_dlq.name
  max_concurrency           = 4

  depends_on = [takoform_worker_deployment.product]
}

resource "takoform_queue_consumer" "delivery_dlq" {
  name                      = "${local.prefix}-delivery-dlq-consumer"
  queue                     = takoform_at_least_once_queue.delivery_dlq.name
  worker                    = takoform_module_worker.product.name
  max_batch_size            = 10
  max_batch_timeout_seconds = 60
  max_retries               = 1
  retry_delay_seconds       = 300
  max_concurrency           = 1

  depends_on = [takoform_worker_deployment.product]
}

resource "takoform_worker_cron_trigger" "retention" {
  name   = "${local.prefix}-retention"
  worker = takoform_module_worker.product.name
  cron   = "0 * * * *"

  depends_on = [takoform_worker_deployment.product]
}
