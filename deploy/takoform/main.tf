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
  description = "Canonical HTTPS origin for Yurucommu. The Takoform Host attaches this exact hostname to the Worker."
  type        = string

  validation {
    condition = can(regex(
      "^https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$",
      var.app_url,
    ))
    error_message = "app_url must be a lowercase HTTPS origin without credentials, a port, path, query, or fragment."
  }
}

variable "takosumi_accounts_url" {
  description = "Takosumi Accounts base URL delivered by the identity.oidc capability."
  type        = string
  default     = ""
}

variable "takosumi_accounts_issuer_url" {
  description = "OIDC issuer URL delivered by the identity.oidc capability."
  type        = string
  default     = ""
}

variable "takosumi_accounts_client_id" {
  description = "Public OIDC client id delivered by the identity.oidc capability."
  type        = string
  default     = ""
}

variable "takosumi_accounts_redirect_uri" {
  description = "Exact OIDC callback URI delivered by the identity.oidc capability."
  type        = string
  default     = ""
}

locals {
  prefix                         = var.project_name
  app_origin                     = trimspace(var.app_url)
  app_hostname                   = trimprefix(local.app_origin, "https://")
  expected_oidc_redirect_uri     = "${local.app_origin}/api/auth/callback/takos"
  worker_bundle_path             = "${path.module}/.generated/yurucommu-worker.js"
  migration_root                 = "${path.module}/.generated/migrations"
  migration_files                = fileset(local.migration_root, "*.sql")
  takosumi_accounts_url          = trimspace(var.takosumi_accounts_url)
  takosumi_accounts_issuer_url   = trimspace(var.takosumi_accounts_issuer_url)
  takosumi_accounts_client_id    = trimspace(var.takosumi_accounts_client_id)
  takosumi_accounts_redirect_uri = trimspace(var.takosumi_accounts_redirect_uri)
  oidc_values = [
    local.takosumi_accounts_url,
    local.takosumi_accounts_issuer_url,
    local.takosumi_accounts_client_id,
    local.takosumi_accounts_redirect_uri,
  ]
  has_any_oidc = anytrue([for value in local.oidc_values : value != ""])
  has_oidc     = alltrue([for value in local.oidc_values : value != ""])
  worker_plain_values = merge(
    {
      APP_URL                = local.app_origin
      YURUCOMMU_RUNTIME_LANE = "takoform-v1"
    },
    local.has_oidc ? {
      TAKOSUMI_ACCOUNTS_URL = local.takosumi_accounts_url
      OIDC_ISSUER_URL       = local.takosumi_accounts_issuer_url
      OIDC_CLIENT_ID        = local.takosumi_accounts_client_id
      OIDC_REDIRECT_URI     = local.takosumi_accounts_redirect_uri
    } : {},
  )
}

resource "takoform_module_worker" "worker" {
  name = local.prefix
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

    precondition {
      condition     = !local.has_any_oidc || local.has_oidc
      error_message = "identity.oidc delivery must provide accountsUrl, issuerUrl, clientId, and redirectUri together."
    }

    precondition {
      condition     = !local.has_oidc || local.takosumi_accounts_redirect_uri == local.expected_oidc_redirect_uri
      error_message = "takosumi_accounts_redirect_uri must equal <app_url>/api/auth/callback/takos."
    }
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

resource "takoform_worker_custom_domain" "worker" {
  name     = "${local.prefix}-domain"
  hostname = local.app_hostname
  worker   = takoform_module_worker.worker.name

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

resource "takoform_worker_cron_trigger" "retention" {
  name   = "${local.prefix}-retention"
  worker = takoform_module_worker.worker.name
  cron   = "0 * * * *"

  depends_on = [takoform_worker_deployment.worker]
}
