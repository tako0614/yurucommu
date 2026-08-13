terraform {
  required_version = ">= 1.5"

  required_providers {
    takoform = {
      source  = "registry.opentofu.org/tako0614/takoform"
      version = "= 1.0.3"
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

variable "worker_release_tag" {
  description = "Yurucommu GitHub release containing takosumi-artifact.json."
  type        = string
  default     = "v2.1.5"

  validation {
    condition     = trimspace(var.worker_release_tag) == "" || can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?$", trimspace(var.worker_release_tag)))
    error_message = "worker_release_tag must be empty or a SemVer-like Git tag beginning with v."
  }
}

variable "worker_bundle_url" {
  description = "Immutable HTTPS Worker artifact URL pinned by this Yurucommu release."
  type        = string
  default     = "https://github.com/tako0614/yurucommu/releases/download/v2.1.5/yurucommu-worker.js"

  validation {
    condition     = can(regex("^https://[^[:space:]]+$", trimspace(var.worker_bundle_url)))
    error_message = "worker_bundle_url must be an https URL."
  }
}

variable "worker_bundle_sha256" {
  description = "Expected SHA-256 for the pinned Worker artifact."
  type        = string
  default     = "sha256:6e39a18ea95172affd2d4b12d24f2e59ab9f5f1af7a14a80ec3989275bed66bd"

  validation {
    condition     = can(regex("^(sha256:)?[a-f0-9]{64}$", trimspace(var.worker_bundle_sha256)))
    error_message = "worker_bundle_sha256 must be lowercase SHA-256 hex or sha256:<hex>."
  }
}

locals {
  release_tag             = trimspace(var.worker_release_tag)
  artifact_url            = trimspace(var.worker_bundle_url)
  artifact_sha256         = trimspace(var.worker_bundle_sha256)
  artifact_sha256_checked = startswith(local.artifact_sha256, "sha256:") ? local.artifact_sha256 : "sha256:${local.artifact_sha256}"
  prefix                  = var.project_name
}

resource "takoform_relational_database" "database" {
  name          = "${local.prefix}-db"
  engine        = "sqlite"
  schema_url    = "https://raw.githubusercontent.com/tako0614/yurucommu/bf7a3bdb55d9bd562ac895ada10ac42ce09a11b9/deploy/takoform/migrations/schema-bundle.json"
  schema_sha256 = "f14135367b4b00a520f0ef8abc41f67d53c6abb9ef8577d946fb199987f5abaa"
  schema_format = "takosumi.resource-migrations"
}

resource "takoform_object_bucket" "media" {
  name          = "${local.prefix}-media"
  storage_class = "standard"
}

resource "takoform_key_value_store" "kv" {
  name        = "${local.prefix}-kv"
  consistency = "eventual"
}

resource "takoform_queue" "delivery" {
  name = "${local.prefix}-delivery"
}

resource "takoform_queue" "delivery_dlq" {
  name = "${local.prefix}-delivery-dlq"
}

resource "takoform_edge_worker" "worker" {
  name                = local.prefix
  artifact_url        = local.artifact_url
  artifact_sha256     = local.artifact_sha256_checked
  artifact_media_type = "application/javascript+module"
  entrypoint          = "yurucommu-worker.js"
  runtime             = "javascript"
  configuration = {
    DELIVERY_QUEUE_NAME = "${local.prefix}-delivery"
    DELIVERY_DLQ_NAME   = "${local.prefix}-delivery-dlq"
  }

  connections = [
    {
      name        = "DB"
      resource    = takoform_relational_database.database.id
      permissions = ["connect", "read", "write"]
      projection  = "sql.binding.v1"
    },
    {
      name        = "DELIVERY_DLQ"
      resource    = takoform_queue.delivery_dlq.id
      permissions = ["consume", "publish"]
      projection  = "queue.binding.v1"
    },
    {
      name        = "DELIVERY_QUEUE"
      resource    = takoform_queue.delivery.id
      permissions = ["consume", "publish"]
      projection  = "queue.binding.v1"
    },
    {
      name        = "KV"
      resource    = takoform_key_value_store.kv.id
      permissions = ["read", "write"]
      projection  = "keyvalue.binding.v1"
    },
    {
      name        = "MEDIA"
      resource    = takoform_object_bucket.media.id
      permissions = ["read", "write"]
      projection  = "object.binding.v1"
    },
  ]

  lifecycle {
    precondition {
      condition     = strcontains(local.artifact_url, "/releases/download/${local.release_tag}/")
      error_message = "worker_bundle_url must select the exact worker_release_tag."
    }

    precondition {
      condition     = can(regex("^https://[^[:space:]]+$", local.artifact_url)) && can(regex("^sha256:[a-f0-9]{64}$", local.artifact_sha256_checked))
      error_message = "The selected Yurucommu Worker artifact must have an immutable HTTPS URL and SHA-256."
    }
  }
}

resource "takoform_schedule" "retention" {
  name     = "${local.prefix}-retention"
  cron     = "0 3 * * *"
  timezone = "UTC"

  connections = [
    {
      name        = "WORKER"
      resource    = takoform_edge_worker.worker.id
      permissions = ["invoke"]
      projection  = "schedule.trigger.v1"
    },
  ]
}

data "takoform_interface" "worker_http" {
  name          = "http.request"
  version       = "1"
  resource_kind = "EdgeWorker"
  resource_name = takoform_edge_worker.worker.name

  depends_on = [takoform_edge_worker.worker]
}
