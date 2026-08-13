# Direct Cloudflare deployment adapter.
#
# Yurucommu's provider-neutral resource authority is
# deploy/product-resources.json. This compatibility root keeps the historical
# module path stable for existing self-hosters while mapping that contract to
# cloudflare/cloudflare resources.
terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.19.1"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

variable "enable_cloudflare_resources" {
  description = "Provision Yurucommu Cloudflare backing resources with the existing cloudflare/cloudflare provider."
  type        = bool
  default     = false
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id used when enable_cloudflare_resources is true."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_cloudflare_resources || trimspace(var.cloudflare_account_id) != ""
    error_message = "cloudflare_account_id is required when enable_cloudflare_resources is true."
  }
}

variable "project_name" {
  description = "Prefix for Yurucommu backing resource names."
  type        = string
  default     = "yurucommu"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

variable "worker_name" {
  description = "Cloudflare Worker name used when enable_cloudflare_worker_script is true. Defaults to project_name."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.worker_name) == "" || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.worker_name))
    error_message = "worker_name must be empty or a 1-63 character lowercase DNS label."
  }
}

variable "app_url" {
  description = "Canonical public URL for the published Yurucommu instance. When empty, launch_url is derived from worker_name and cloudflare_workers_subdomain."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.app_url) == "" || can(regex("^https://[^[:space:]]+$", var.app_url))
    error_message = "app_url must be empty or an https URL."
  }
}

variable "encryption_key" {
  description = "Sensitive Yurucommu encryption key injected as the ENCRYPTION_KEY Worker secret. Leave empty when the runtime is not managed by this OpenTofu module."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = trimspace(var.encryption_key) == "" || can(regex("^[a-f0-9]{64}$", trimspace(var.encryption_key)))
    error_message = "encryption_key must be empty or a 64-character lowercase hex key."
  }
}

variable "auth_password_hash" {
  description = "Bootstrap password hash/token injected as AUTH_PASSWORD_HASH. Required for a managed Worker unless Takosumi Accounts OIDC is configured."
  type        = string
  default     = ""
  sensitive   = true
}

variable "takosumi_accounts_issuer_url" {
  description = "Optional Takosumi Accounts OIDC issuer URL used as a public auth method for auto-provisioned Capsules."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.takosumi_accounts_issuer_url) == "" || can(regex("^https://[^[:space:]]+$", trimspace(var.takosumi_accounts_issuer_url)))
    error_message = "takosumi_accounts_issuer_url must be empty or an https URL."
  }
}

variable "takosumi_accounts_client_id" {
  description = "Optional Takosumi Accounts public OIDC client id used with takosumi_accounts_issuer_url."
  type        = string
  default     = ""
}

variable "oidc_owner_sub" {
  description = "OIDC/OAuth subject pinned to the single owner slot. Only this subject may become owner on first login; every other first-login is refused."
  type        = string
  default     = ""
}

variable "oidc_allowed_subs" {
  description = "Comma-separated OIDC/OAuth subjects allowed to auto-provision a non-owner member account. Empty keeps member auto-provisioning closed."
  type        = string
  default     = ""
}

variable "allow_unpinned_owner_claim" {
  description = "Allow an OIDC-only install to hand the owner slot to whoever signs in first. The pairwise subject is unknown before the first login, so a fresh install sets this, signs in, then pins oidc_owner_sub and clears it."
  type        = bool
  default     = false
}

variable "notification_push_gateway_url" {
  description = "Optional public HTTPS notify endpoint for the stateless notification push gateway."
  type        = string
  default     = ""

  validation {
    condition = trimspace(var.notification_push_gateway_url) == "" || (
      can(regex("^https://[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z0-9-]+(:443)?(/[^[:space:]#]*)?(\\?[^[:space:]#]*)?$", trimspace(var.notification_push_gateway_url))) &&
      !can(regex("^https://[0-9]+(\\.[0-9]+){3}(:443)?(/|$)", trimspace(var.notification_push_gateway_url))) &&
      !can(regex("^https://[^/:?#]+\\.(localhost|local|internal|home|lan)(:443)?(/|$)", lower(trimspace(var.notification_push_gateway_url))))
    )
    error_message = "notification_push_gateway_url must be empty or a public-DNS https URL using the default/443 port."
  }
}

variable "notification_push_gateway_token" {
  description = "Optional bearer used only by the Yurucommu Worker when calling the exact notification_push_gateway_url."
  type        = string
  default     = ""
  sensitive   = true
}

variable "notification_push_web_push_public_key" {
  description = "Optional public base64url VAPID P-256 key exposed to browser clients for Web Push subscription."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.notification_push_web_push_public_key) == "" || can(regex("^B[A-P][A-Za-z0-9_-]{85}$", trimspace(var.notification_push_web_push_public_key)))
    error_message = "notification_push_web_push_public_key must be empty or an unpadded 87-character base64url uncompressed P-256 public key."
  }
}

variable "env" {
  description = "Additional non-secret Worker environment variables projected as plain_text bindings. Secrets must use dedicated sensitive variables or Provider Connections."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for name, value in var.env :
      can(regex("^[A-Z_][A-Z0-9_]{0,127}$", name)) &&
      !can(regex("(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_?KEY|API_?KEY)", upper(name))) &&
      !contains([
        "DB",
        "KV",
        "MEDIA",
        "DELIVERY_QUEUE",
        "DELIVERY_DLQ",
        "APP_URL",
        "DELIVERY_QUEUE_NAME",
        "DELIVERY_DLQ_NAME",
        "ENCRYPTION_KEY",
        "AUTH_PASSWORD_HASH",
        "TAKOSUMI_ACCOUNTS_ISSUER_URL",
        "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        "OIDC_OWNER_SUB",
        "TAKOSUMI_ACCOUNTS_OWNER_SUB",
        "OIDC_ALLOWED_SUBS",
        "ALLOW_UNPINNED_OWNER_CLAIM",
        "YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_ALLOWED_HOSTS",
        "YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_URL",
        "YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_TOKEN",
        "YURUCOMMU_NOTIFICATION_PUSH_WEB_PUSH_PUBLIC_KEY",
      ], name)
    ])
    error_message = "env keys must be uppercase Worker plain-text variable names and must not be secret-like or reserved by the Yurucommu module."
  }
}

variable "cloudflare_workers_subdomain" {
  description = "Cloudflare workers.dev subdomain used to derive launch_url for Worker-dev deployments."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.cloudflare_workers_subdomain) == "" || can(regex("^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$", var.cloudflare_workers_subdomain))
    error_message = "cloudflare_workers_subdomain must be empty or a valid workers.dev subdomain label."
  }
}

variable "enable_cloudflare_worker_script" {
  description = "Deploy the Yurucommu Worker script, bindings, queue consumers, route, and optional workers.dev enablement through OpenTofu."
  type        = bool
  default     = false
}

variable "worker_bundle_path" {
  description = "Local path to a source-built Worker module JS file. Used only when worker_release_tag and worker_bundle_url are both empty."
  type        = string
  default     = "dist/yurucommu-worker.js"
}

variable "worker_release_tag" {
  description = "Immutable GitHub release identity for the Worker artifact. With no explicit worker_bundle_url it selects the append-only release.lock.json entry; with an explicit URL the URL must select this exact tag. Set both empty to use worker_bundle_path."
  type        = string
  default     = "v2.1.5"

  validation {
    condition     = trimspace(var.worker_release_tag) == "" || can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?$", trimspace(var.worker_release_tag)))
    error_message = "worker_release_tag must be empty or a SemVer-like Git tag beginning with v."
  }
}

variable "worker_bundle_url" {
  description = "Optional HTTPS URL for a prebuilt Worker module JS artifact. When set, OpenTofu downloads this artifact and verifies worker_bundle_sha256 before upload."
  type        = string
  default     = "https://github.com/tako0614/yurucommu/releases/download/v2.1.5/yurucommu-worker.js"

  validation {
    condition     = trimspace(var.worker_bundle_url) == "" || can(regex("^https://[^[:space:]]+$", trimspace(var.worker_bundle_url)))
    error_message = "worker_bundle_url must be empty or an https URL."
  }
}

variable "worker_bundle_sha256" {
  description = "Expected SHA-256 assertion for an explicit worker_bundle_url or local worker_bundle_path. Accepts lowercase hex or sha256:<hex>. When worker_bundle_url is empty and worker_release_tag selects release.lock.json, a supplied value must equal that pin."
  type        = string
  default     = "sha256:6e39a18ea95172affd2d4b12d24f2e59ab9f5f1af7a14a80ec3989275bed66bd"

  validation {
    condition     = trimspace(var.worker_bundle_sha256) == "" || can(regex("^(sha256:)?[a-f0-9]{64}$", trimspace(var.worker_bundle_sha256)))
    error_message = "worker_bundle_sha256 must be empty, a lowercase 64-character hex SHA-256 digest, or sha256:<hex>."
  }
}

variable "worker_main_module" {
  description = "Module name used as the Cloudflare Worker main module when uploading worker_bundle_path."
  type        = string
  default     = "worker.js"
}

variable "worker_assets_directory" {
  description = "Static assets directory uploaded with the Worker when enable_worker_assets is true. The default artifact embeds assets, so this is normally only needed for direct Cloudflare local builds."
  type        = string
  default     = "dist"
}

variable "enable_worker_assets" {
  description = "Upload worker_assets_directory as Cloudflare Workers static assets with the Worker script. Remote worker_bundle_url artifacts are expected to embed assets, so this is ignored when worker_bundle_url is set."
  type        = bool
  default     = false
}

variable "enable_workers_dev_subdomain" {
  description = "Enable the Worker on the account's workers.dev subdomain when enable_cloudflare_worker_script is true."
  type        = bool
  default     = true
}

variable "cloudflare_route_zone_id" {
  description = "Optional Cloudflare zone id used to create a Worker route. For Takosumi Cloud compat this is the virtual zone id."
  type        = string
  default     = ""
}

variable "cloudflare_route_pattern" {
  description = "Optional Worker route pattern, for example example.com/* or my-app.app.takos.jp/*."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.cloudflare_route_pattern) == "" || can(regex("^[^[:space:]]+/\\*$", trimspace(var.cloudflare_route_pattern)))
    error_message = "cloudflare_route_pattern must be empty or a Worker route pattern ending in /*."
  }
}

variable "worker_compatibility_date" {
  description = "Cloudflare Workers compatibility date for the OpenTofu-managed Worker script."
  type        = string
  default     = "2026-04-01"
}

variable "worker_compatibility_flags" {
  description = "Cloudflare Workers compatibility flags for the OpenTofu-managed Worker script."
  type        = set(string)
  default     = ["nodejs_compat", "global_fetch_strictly_public"]
}

locals {
  cloudflare_resources_enabled = var.enable_cloudflare_resources
  cloudflare_worker_enabled    = local.cloudflare_resources_enabled && var.enable_cloudflare_worker_script
  cloudflare_route_enabled     = local.cloudflare_worker_enabled && trimspace(var.cloudflare_route_zone_id) != "" && trimspace(var.cloudflare_route_pattern) != ""
  # A release tag only selects an append-only in-tree pin. The fetched manifest
  # is checked against that pin and never supplies its own expected digest.
  release_lock                   = jsondecode(file("${path.module}/release.lock.json"))
  worker_release_tag             = trimspace(var.worker_release_tag)
  worker_bundle_explicit_url     = trimspace(var.worker_bundle_url)
  worker_bundle_uses_manifest    = local.cloudflare_worker_enabled && local.worker_bundle_explicit_url == "" && local.worker_release_tag != ""
  worker_release_pin             = try(local.release_lock.releases[local.worker_release_tag], null)
  worker_release_manifest_body   = local.worker_bundle_uses_manifest ? data.http.worker_release_manifest[0].response_body : null
  worker_release_manifest        = local.worker_bundle_uses_manifest ? jsondecode(local.worker_release_manifest_body) : null
  worker_release_manifest_digest = local.worker_bundle_uses_manifest ? sha256(local.worker_release_manifest_body) : null
  worker_release_expected_manifest_sha256 = startswith(try(local.worker_release_pin.manifest.sha256, ""), "sha256:") ? replace(
    try(local.worker_release_pin.manifest.sha256, ""),
    "sha256:",
    "",
  ) : try(local.worker_release_pin.manifest.sha256, "")
  worker_release_expected_artifact_sha256 = startswith(try(local.worker_release_pin.artifact.sha256, ""), "sha256:") ? replace(
    try(local.worker_release_pin.artifact.sha256, ""),
    "sha256:",
    "",
  ) : try(local.worker_release_pin.artifact.sha256, "")
  worker_bundle_url             = local.worker_bundle_explicit_url != "" ? local.worker_bundle_explicit_url : (local.worker_bundle_uses_manifest ? try(local.worker_release_pin.artifact.url, "") : "")
  worker_bundle_uses_url        = local.cloudflare_worker_enabled && local.worker_bundle_url != ""
  worker_bundle_sha256_input    = trimspace(var.worker_bundle_sha256)
  worker_bundle_sha256_override = startswith(local.worker_bundle_sha256_input, "sha256:") ? replace(local.worker_bundle_sha256_input, "sha256:", "") : local.worker_bundle_sha256_input
  worker_bundle_expected_sha256 = local.worker_bundle_uses_manifest ? local.worker_release_expected_artifact_sha256 : local.worker_bundle_sha256_override
  worker_bundle_local_path      = startswith(var.worker_bundle_path, "/") ? var.worker_bundle_path : "${path.module}/${var.worker_bundle_path}"
  worker_bundle_body            = local.worker_bundle_uses_url ? data.http.worker_bundle[0].response_body : null
  worker_bundle_content_sha256  = local.cloudflare_worker_enabled ? (local.worker_bundle_uses_url ? sha256(data.http.worker_bundle[0].response_body) : (local.worker_bundle_uses_manifest ? null : filesha256(local.worker_bundle_local_path))) : null
  worker_assets_enabled         = local.cloudflare_worker_enabled && var.enable_worker_assets && !local.worker_bundle_uses_url
  resource_prefix               = var.project_name
  worker_name                   = trimspace(var.worker_name) != "" ? trimspace(var.worker_name) : local.resource_prefix
  workers_dev_url               = trimspace(var.cloudflare_workers_subdomain) != "" ? "https://${local.worker_name}.${trimspace(var.cloudflare_workers_subdomain)}.workers.dev" : null
  launch_url                    = trimspace(var.app_url) != "" ? trimspace(var.app_url) : local.workers_dev_url
  provided_encryption_key       = trimspace(var.encryption_key)
  provided_auth_password_hash   = trimspace(var.auth_password_hash)
  has_takosumi_accounts_oidc    = trimspace(var.takosumi_accounts_issuer_url) != "" && trimspace(var.takosumi_accounts_client_id) != ""
  effective_encryption_key      = local.provided_encryption_key != "" ? local.provided_encryption_key : random_id.encryption_key.hex
  effective_auth_password_hash  = local.provided_auth_password_hash
  extra_worker_env              = { for name, value in var.env : name => value if trimspace(value) != "" }
  notification_push_gateway_url = trimspace(var.notification_push_gateway_url)
  notification_push_gateway_host = try(regex(
    "^https://([^/:?#]+)",
    local.notification_push_gateway_url,
  )[0], "")
  notification_push_web_push_public_key = trimspace(var.notification_push_web_push_public_key)
  notification_push_gateway_token       = trimspace(var.notification_push_gateway_token)
  oidc_owner_sub                        = trimspace(var.oidc_owner_sub)
  oidc_allowed_subs                     = trimspace(var.oidc_allowed_subs)

  d1_database_name    = "${local.resource_prefix}-db"
  r2_media_bucket     = "${local.resource_prefix}-media"
  kv_namespace_title  = "${local.resource_prefix}-kv"
  delivery_queue_name = "${local.resource_prefix}-delivery"
  delivery_dlq_name   = "${local.resource_prefix}-delivery-dlq"
}

data "http" "worker_release_manifest" {
  count              = local.worker_bundle_uses_manifest ? 1 : 0
  url                = try(local.worker_release_pin.manifest.url, "https://invalid.example.invalid/unpinned-release")
  request_timeout_ms = 30000

  request_headers = {
    Accept = "application/json"
  }

  retry {
    attempts     = 3
    min_delay_ms = 500
    max_delay_ms = 5000
  }

  lifecycle {
    precondition {
      condition     = local.worker_release_pin != null
      error_message = "worker_release_tag is not pinned in release.lock.json; published release pins are append-only."
    }
  }
}

resource "random_id" "encryption_key" {
  byte_length = 32

  keepers = {
    project_name = local.resource_prefix
  }
}

data "http" "worker_bundle" {
  count              = local.worker_bundle_uses_url ? 1 : 0
  url                = local.worker_bundle_url
  request_timeout_ms = 120000

  request_headers = {
    Accept = "application/javascript, text/javascript, application/octet-stream"
  }

  retry {
    attempts     = 3
    min_delay_ms = 1000
    max_delay_ms = 10000
  }
}

resource "cloudflare_d1_database" "database" {
  count      = local.cloudflare_resources_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = local.d1_database_name
}

resource "cloudflare_r2_bucket" "media" {
  count      = local.cloudflare_resources_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = local.r2_media_bucket
}

resource "cloudflare_workers_kv_namespace" "kv" {
  count      = local.cloudflare_resources_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  title      = local.kv_namespace_title
}

resource "cloudflare_queue" "delivery" {
  count      = local.cloudflare_resources_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  queue_name = local.delivery_queue_name
}

resource "cloudflare_queue" "delivery_dlq" {
  count      = local.cloudflare_resources_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  queue_name = local.delivery_dlq_name
}

resource "cloudflare_workers_script" "worker" {
  count               = local.cloudflare_worker_enabled ? 1 : 0
  account_id          = var.cloudflare_account_id
  script_name         = local.worker_name
  content             = local.worker_bundle_uses_url ? sensitive(local.worker_bundle_body) : null
  content_file        = local.worker_bundle_uses_url ? null : local.worker_bundle_local_path
  content_sha256      = local.worker_bundle_content_sha256
  main_module         = var.worker_main_module
  compatibility_date  = var.worker_compatibility_date
  compatibility_flags = var.worker_compatibility_flags

  assets = local.worker_assets_enabled ? {
    directory = var.worker_assets_directory
    config = {
      run_worker_first   = true
      not_found_handling = "single-page-application"
    }
  } : null

  bindings = concat(
    [
      {
        type        = "d1"
        name        = "DB"
        database_id = cloudflare_d1_database.database[0].id
      },
      {
        type         = "kv_namespace"
        name         = "KV"
        namespace_id = cloudflare_workers_kv_namespace.kv[0].id
      },
      {
        type        = "r2_bucket"
        name        = "MEDIA"
        bucket_name = cloudflare_r2_bucket.media[0].name
      },
      {
        type       = "queue"
        name       = "DELIVERY_QUEUE"
        queue_name = cloudflare_queue.delivery[0].queue_name
      },
      {
        type       = "queue"
        name       = "DELIVERY_DLQ"
        queue_name = cloudflare_queue.delivery_dlq[0].queue_name
      },
      {
        type = "plain_text"
        name = "APP_URL"
        text = local.launch_url != null ? local.launch_url : ""
      },
      {
        type = "plain_text"
        name = "DELIVERY_QUEUE_NAME"
        text = cloudflare_queue.delivery[0].queue_name
      },
      {
        type = "plain_text"
        name = "DELIVERY_DLQ_NAME"
        text = cloudflare_queue.delivery_dlq[0].queue_name
      },
    ],
    [
      for name, value in local.extra_worker_env : {
        type = "plain_text"
        name = name
        text = value
      }
    ],
    local.oidc_owner_sub != "" ? [
      {
        type = "plain_text"
        name = "OIDC_OWNER_SUB"
        text = local.oidc_owner_sub
      },
    ] : [],
    local.oidc_allowed_subs != "" ? [
      {
        type = "plain_text"
        name = "OIDC_ALLOWED_SUBS"
        text = local.oidc_allowed_subs
      },
    ] : [],
    # The worker refuses to hand the owner slot to an unpinned first login. The
    # acknowledgement below is what actually opens it, so it has to reach the
    # runtime -- otherwise an install that legitimately cannot know the pairwise
    # subject yet passes the precondition and then can never be bootstrapped.
    local.oidc_owner_sub == "" && var.allow_unpinned_owner_claim ? [
      {
        type = "plain_text"
        name = "ALLOW_UNPINNED_OWNER_CLAIM"
        text = "true"
      },
    ] : [],
    [
      {
        type = "secret_text"
        name = "ENCRYPTION_KEY"
        text = local.effective_encryption_key
      },
    ],
    local.effective_auth_password_hash != "" ? [
      {
        type = "secret_text"
        name = "AUTH_PASSWORD_HASH"
        text = local.effective_auth_password_hash
      },
    ] : [],
    local.has_takosumi_accounts_oidc ? [
      {
        type = "plain_text"
        name = "TAKOSUMI_ACCOUNTS_ISSUER_URL"
        text = trimspace(var.takosumi_accounts_issuer_url)
      },
      {
        type = "plain_text"
        name = "TAKOSUMI_ACCOUNTS_CLIENT_ID"
        text = trimspace(var.takosumi_accounts_client_id)
      },
    ] : [],
    local.notification_push_gateway_url != "" ? [
      {
        type = "plain_text"
        name = "YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_URL"
        text = local.notification_push_gateway_url
      },
      {
        type = "plain_text"
        name = "YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_ALLOWED_HOSTS"
        text = local.notification_push_gateway_host
      },
    ] : [],
    local.notification_push_web_push_public_key != "" ? [
      {
        type = "plain_text"
        name = "YURUCOMMU_NOTIFICATION_PUSH_WEB_PUSH_PUBLIC_KEY"
        text = local.notification_push_web_push_public_key
      },
    ] : [],
    local.notification_push_gateway_token != "" ? [
      {
        type = "secret_text"
        name = "YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_TOKEN"
        text = local.notification_push_gateway_token
      },
    ] : [],
  )

  lifecycle {
    # A generated-but-undisclosed bootstrap token produces a deployment that is
    # technically healthy but impossible for its owner to enter. Authentication
    # is therefore an explicit input: password or configured OIDC, never an
    # implicit random credential hidden in state.
    precondition {
      condition     = local.provided_auth_password_hash != "" || local.has_takosumi_accounts_oidc
      error_message = "A managed Yurucommu Worker requires auth_password_hash or a complete Takosumi Accounts OIDC issuer/client configuration."
    }

    precondition {
      condition = !local.worker_bundle_uses_manifest || (
        try(local.release_lock.kind, "") == "takos.release-artifact-lock@v1" &&
        try(local.release_lock.app, "") == "yurucommu" &&
        local.worker_release_pin != null &&
        can(regex("^[a-f0-9]{40}$", try(local.worker_release_pin.commit, ""))) &&
        can(regex("^https://[^[:space:]]+$", try(local.worker_release_pin.artifact.url, ""))) &&
        can(regex("^https://[^[:space:]]+$", try(local.worker_release_pin.manifest.url, ""))) &&
        can(regex("^[a-f0-9]{64}$", local.worker_release_expected_artifact_sha256)) &&
        can(regex("^[a-f0-9]{64}$", local.worker_release_expected_manifest_sha256)) &&
        local.worker_release_manifest_digest == local.worker_release_expected_manifest_sha256 &&
        try(local.worker_release_manifest.kind, "") == "takosumi.worker-artifact@v1" &&
        try(local.worker_release_manifest.app, "") == "yurucommu" &&
        try(local.worker_release_manifest.releaseTag, "") == local.worker_release_tag &&
        try(local.worker_release_manifest.ref, "") == local.worker_release_tag &&
        try(local.worker_release_manifest.commit, "") == try(local.worker_release_pin.commit, "") &&
        try(local.worker_release_manifest.artifact.filename, "") == try(local.worker_release_pin.artifact.filename, "") &&
        try(local.worker_release_manifest.artifact.url, "") == try(local.worker_release_pin.artifact.url, "") &&
        try(local.worker_release_manifest.artifact["sha256"], "") == local.worker_release_expected_artifact_sha256 &&
        try(local.worker_release_manifest.manifestUrl, "") == try(local.worker_release_pin.manifest.url, "") &&
        local.worker_bundle_uses_url
      )
      error_message = "worker_release_tag must have an append-only yurucommu release pin whose manifest digest, identity, commit, tag, artifact URL/digest, and manifest URL match the fetched release."
    }

    precondition {
      condition     = !local.worker_bundle_uses_manifest || local.worker_bundle_sha256_override == "" || local.worker_bundle_sha256_override == local.worker_release_expected_artifact_sha256
      error_message = "worker_bundle_sha256 cannot override a worker_release_tag pin; omit it or set it to the release.lock.json artifact digest."
    }

    precondition {
      condition     = local.worker_bundle_explicit_url == "" || local.worker_release_tag == "" || strcontains(local.worker_bundle_explicit_url, "/releases/download/${local.worker_release_tag}/")
      error_message = "An explicit worker_bundle_url must select the exact worker_release_tag."
    }

    precondition {
      condition     = !local.worker_bundle_uses_url || (local.worker_bundle_expected_sha256 != "" && local.worker_bundle_expected_sha256 == local.worker_bundle_content_sha256)
      error_message = "The selected release.lock.json or worker_bundle_sha256 digest must match the downloaded Worker artifact."
    }

    precondition {
      condition     = local.worker_bundle_uses_url || local.worker_bundle_uses_manifest || local.worker_bundle_expected_sha256 == "" || local.worker_bundle_expected_sha256 == local.worker_bundle_content_sha256
      error_message = "worker_bundle_sha256 does not match worker_bundle_path."
    }

    precondition {
      condition     = (local.notification_push_gateway_url == "") == (local.notification_push_web_push_public_key == "")
      error_message = "notification_push_gateway_url and notification_push_web_push_public_key must be configured together."
    }

    precondition {
      condition     = local.notification_push_gateway_token == "" || local.notification_push_gateway_url != ""
      error_message = "notification_push_gateway_token requires notification_push_gateway_url."
    }

    # Owner-slot race. With Takosumi Accounts OIDC configured, auth_password_hash
    # is forced empty and OIDC becomes the only login path, so whoever completes
    # the flow first permanently owns the instance. The pairwise subject is not
    # knowable before that first login, so the module cannot simply require the
    # pin — it requires an explicit, auditable acknowledgement instead.
    precondition {
      condition     = !local.has_takosumi_accounts_oidc || local.oidc_owner_sub != "" || var.allow_unpinned_owner_claim
      error_message = "takosumi_accounts_issuer_url installs must set oidc_owner_sub, or set allow_unpinned_owner_claim = true to accept that the first sign-in takes the owner slot."
    }
  }
}

resource "cloudflare_queue_consumer" "delivery" {
  count             = local.cloudflare_worker_enabled ? 1 : 0
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.delivery[0].queue_id
  script_name       = cloudflare_workers_script.worker[0].script_name
  type              = "worker"
  dead_letter_queue = cloudflare_queue.delivery_dlq[0].queue_name

  settings = {
    batch_size       = 10
    max_retries      = 3
    max_wait_time_ms = 1000
  }
}

resource "cloudflare_queue_consumer" "delivery_dlq" {
  count       = local.cloudflare_worker_enabled ? 1 : 0
  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.delivery_dlq[0].queue_id
  script_name = cloudflare_workers_script.worker[0].script_name
  type        = "worker"

  settings = {
    batch_size       = 10
    max_retries      = 1
    max_wait_time_ms = 60000
  }
}

# Retention sweep. The Capsule path has no wrangler.jsonc, so the cron trigger
# has to be a resource here or the worker's scheduled() handler never fires and
# the delivery/session/call/media purges grow forever. Hourly matches the Bun
# self-host interval; each pass is LIMIT-bounded.
resource "cloudflare_workers_cron_trigger" "retention" {
  count       = local.cloudflare_worker_enabled ? 1 : 0
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.worker[0].script_name

  schedules = [
    {
      cron = "0 * * * *"
    },
  ]
}

resource "cloudflare_workers_script_subdomain" "worker" {
  count            = local.cloudflare_worker_enabled && var.enable_workers_dev_subdomain ? 1 : 0
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.worker[0].script_name
  enabled          = true
  previews_enabled = false
}

resource "cloudflare_workers_route" "worker" {
  count   = local.cloudflare_route_enabled ? 1 : 0
  zone_id = trimspace(var.cloudflare_route_zone_id)
  pattern = trimspace(var.cloudflare_route_pattern)
  script  = cloudflare_workers_script.worker[0].script_name
}
