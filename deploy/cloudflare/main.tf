# Direct Cloudflare install module.
#
# Installs Yurucommu straight onto the Cloudflare account behind a Cloudflare
# Provider Connection, with the official cloudflare/cloudflare provider and no
# Takoform Host or Takoserver in between. It maps the same product-owned
# contract as deploy/takoform (deploy/product-resources.json): one Worker, one
# D1 database, one KV namespace, one R2 bucket, a delivery queue and its
# dead-letter queue with one consumer each, and an hourly retention cron.
#
# The root module is the older self-host adapter that publishes a released
# artifact and leaves the schema to the operator. This module is built from
# source (`sourceBuild` in .well-known/takosumi.json) so the Worker carries the
# locked schema bundle and applies it to its own D1 database before serving
# (YURUCOMMU_APPLY_BUNDLED_MIGRATIONS, scripts/yurucommu-d1-migrations.ts).
terraform {
  required_version = ">= 1.8"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # The exact release in Takosumi's runner provider mirror
      # (takosumi runner/mirror-providers.tf) and the root module.
      version = "= 5.19.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Supplied by a checked Takosumi Cloudflare Provider Connection
# (moduleInputDefaults). Plain OpenTofu callers pass them directly.
# ---------------------------------------------------------------------------

variable "cloudflare_account_id" {
  description = "Cloudflare account that receives every resource. A Takosumi Cloudflare connection supplies it."
  type        = string

  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hex Cloudflare account id."
  }
}

variable "cloudflare_workers_subdomain" {
  description = "The account's workers.dev subdomain. A Takosumi Cloudflare connection supplies it; when set, a workers.dev app_url must be exactly this Worker's URL."
  type        = string
  default     = ""

  validation {
    condition     = var.cloudflare_workers_subdomain == "" || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.cloudflare_workers_subdomain))
    error_message = "cloudflare_workers_subdomain must be empty or one workers.dev subdomain label."
  }
}

# ---------------------------------------------------------------------------
# Identity and public address
# ---------------------------------------------------------------------------

variable "project_name" {
  description = "Prefix for every Cloudflare resource of this instance (Worker, D1, KV, R2, queues)."
  type        = string
  default     = "yurucommu"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

variable "worker_name" {
  description = "Cloudflare Worker name. Defaults to project_name."
  type        = string
  default     = ""

  validation {
    condition     = var.worker_name == "" || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.worker_name))
    error_message = "worker_name must be empty or a 1-63 character lowercase DNS label."
  }
}

variable "app_url" {
  description = "Canonical public origin: https://<worker_name>.<workers.dev subdomain>.workers.dev, or a custom hostname such as https://social.example.com, which is attached as a Workers Custom Domain in cloudflare_zone_id. Required: Takosumi registers the OIDC redirect against it, and the Worker mints actor ids from it."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.app_url))
    error_message = "app_url must be a lowercase https origin with no port, path, query, or trailing slash."
  }
}

variable "cloudflare_zone_id" {
  description = "Zone that holds a custom app_url hostname. Required only when app_url is not a workers.dev URL."
  type        = string
  default     = ""

  validation {
    condition     = var.cloudflare_zone_id == "" || can(regex("^[a-f0-9]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be empty or a 32-character lowercase hex zone id."
  }
}

# ---------------------------------------------------------------------------
# Instance secrets. Takosumi cannot yet deliver a generated secret to a plain
# cloudflare/cloudflare module (secret.generated only reaches a Takoform Host),
# so an empty value is generated once here and kept in OpenTofu state, which a
# secret_text binding stores anyway. Supply a value only to adopt an existing
# instance's key/salt; never rotate either on a live instance.
# ---------------------------------------------------------------------------

variable "encryption_key" {
  description = "Optional 64-character lowercase hex ENCRYPTION_KEY. Empty generates and keeps one."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.encryption_key == "" || can(regex("^[a-f0-9]{64}$", var.encryption_key))
    error_message = "encryption_key must be empty or a 64-character lowercase hex key."
  }
}

variable "session_hash_salt" {
  description = "Optional YURUCOMMU_SESSION_HASH_SALT. Empty generates and keeps a 32-byte hex salt."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.session_hash_salt == "" || trimspace(var.session_hash_salt) != ""
    error_message = "session_hash_salt must be empty (generate one) or a non-blank value."
  }
}

variable "auth_password_hash" {
  description = "Optional AUTH_PASSWORD_HASH: a canonical PBKDF2 salt:hash or a one-time bootstrap secret. Needed unless Takosumi Accounts OIDC is configured."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.auth_password_hash == trimspace(var.auth_password_hash)
    error_message = "auth_password_hash must not have leading or trailing whitespace."
  }
}

# ---------------------------------------------------------------------------
# Takosumi Accounts OIDC (identity.oidc variable delivery)
# ---------------------------------------------------------------------------

variable "takosumi_accounts_url" {
  description = "Takosumi Accounts base URL delivered with the OIDC client. Accepted for the delivery contract; the Worker reads the issuer."
  type        = string
  default     = ""
}

variable "takosumi_accounts_issuer_url" {
  description = "Takosumi Accounts OIDC issuer URL."
  type        = string
  default     = ""

  validation {
    condition     = var.takosumi_accounts_issuer_url == "" || can(regex("^https://[^[:space:]]+$", var.takosumi_accounts_issuer_url))
    error_message = "takosumi_accounts_issuer_url must be empty or an https URL."
  }
}

variable "takosumi_accounts_client_id" {
  description = "Takosumi Accounts public OIDC client id registered for this instance."
  type        = string
  default     = ""
}

variable "takosumi_accounts_redirect_uri" {
  description = "Redirect URI Takosumi registered for the client. When set it must be app_url + /api/auth/callback/takos, which is what the Worker sends."
  type        = string
  default     = ""
}

variable "oidc_owner_sub" {
  description = "OIDC subject pinned to the single owner slot."
  type        = string
  default     = ""
}

variable "oidc_allowed_subs" {
  description = "Comma-separated OIDC subjects allowed to auto-provision a member account. Empty keeps member auto-provisioning closed."
  type        = string
  default     = ""
}

# Not offered through Takosumi. Without a pin, Core grants the first owner only
# to a sign-in whose signed Takosumi Accounts claim carries app_role = owner,
# which Accounts issues to the installing principal of this client. Turning
# this on instead lets ANY subject the issuer authenticates take the owner slot
# of a guessable workers.dev URL before the installer does, permanently.
variable "allow_unpinned_owner_claim" {
  description = "Plain-OpenTofu escape hatch for an issuer without Takosumi app grants: with OIDC and no oidc_owner_sub, let the first sign-in take the owner slot. Never needed for a Takosumi install."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Optional native push gateway
# ---------------------------------------------------------------------------

variable "notification_push_gateway_url" {
  description = "Optional public HTTPS notify endpoint of the stateless push gateway for native app pushers. Browser Web Push needs no gateway."
  type        = string
  default     = ""

  validation {
    condition = var.notification_push_gateway_url == "" || (
      can(regex("^https://[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z0-9-]+(:443)?(/[^[:space:]#]*)?(\\?[^[:space:]#]*)?$", var.notification_push_gateway_url)) &&
      !can(regex("^https://[0-9]+(\\.[0-9]+){3}(:443)?(/|$)", var.notification_push_gateway_url)) &&
      !can(regex("^https://[^/:?#]+\\.(localhost|local|internal|home|lan)(:443)?(/|$)", lower(var.notification_push_gateway_url)))
    )
    error_message = "notification_push_gateway_url must be empty or a public-DNS https URL using the default/443 port."
  }
}

variable "notification_push_gateway_token" {
  description = "Optional bearer used only when calling notification_push_gateway_url."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Runtime. The values match the official wrangler.jsonc deployment.
# ---------------------------------------------------------------------------

variable "worker_compatibility_date" {
  description = "Workers compatibility date."
  type        = string
  default     = "2026-07-16"
}

variable "worker_compatibility_flags" {
  description = "Workers compatibility flags."
  type        = set(string)
  default     = ["nodejs_compat", "global_fetch_strictly_public"]
}

locals {
  worker_bundle_path = "${path.module}/.generated/yurucommu-worker.js"
  worker_name        = var.worker_name != "" ? var.worker_name : var.project_name

  workers_dev_url = var.cloudflare_workers_subdomain != "" ? "https://${local.worker_name}.${var.cloudflare_workers_subdomain}.workers.dev" : ""
  launch_url      = var.app_url
  app_host        = trimprefix(var.app_url, "https://")
  # One origin per instance: actor ids, the OIDC redirect, and cookies all
  # follow APP_URL, so a custom-domain instance does not also answer on
  # workers.dev.
  app_on_workers = endswith(local.app_host, ".workers.dev")
  custom_domain  = local.app_on_workers ? "" : local.app_host

  d1_database_name    = "${var.project_name}-db"
  kv_namespace_title  = "${var.project_name}-kv"
  r2_media_bucket     = "${var.project_name}-media"
  delivery_queue_name = "${var.project_name}-delivery"
  delivery_dlq_name   = "${var.project_name}-delivery-dlq"

  encryption_key    = var.encryption_key != "" ? var.encryption_key : random_bytes.encryption_key.hex
  session_hash_salt = var.session_hash_salt != "" ? var.session_hash_salt : random_bytes.session_hash_salt.hex

  has_oidc = var.takosumi_accounts_issuer_url != "" && var.takosumi_accounts_client_id != ""

  push_gateway_host = try(regex("^https://([^/:?#]+)", var.notification_push_gateway_url)[0], "")

  # Plain variables. DELIVERY_QUEUE_NAME / DELIVERY_DLQ_NAME are how the queue
  # handler tells its two consumers apart, so they come from the same locals
  # the queues are named from. YURUCOMMU_RUNTIME_LANE names the raw Cloudflare
  # binding shape, and YURUCOMMU_APPLY_BUNDLED_MIGRATIONS hands the D1 schema to
  # the Worker because nothing else in this lane applies it.
  plain_vars = merge(
    {
      APP_URL                            = local.launch_url
      DELIVERY_QUEUE_NAME                = local.delivery_queue_name
      DELIVERY_DLQ_NAME                  = local.delivery_dlq_name
      YURUCOMMU_RUNTIME_LANE             = "cloudflare"
      YURUCOMMU_APPLY_BUNDLED_MIGRATIONS = "true"
    },
    local.has_oidc ? {
      TAKOSUMI_ACCOUNTS_ISSUER_URL = var.takosumi_accounts_issuer_url
      TAKOSUMI_ACCOUNTS_CLIENT_ID  = var.takosumi_accounts_client_id
    } : {},
    var.oidc_owner_sub != "" ? { OIDC_OWNER_SUB = var.oidc_owner_sub } : {},
    var.oidc_allowed_subs != "" ? { OIDC_ALLOWED_SUBS = var.oidc_allowed_subs } : {},
    var.oidc_owner_sub == "" && var.allow_unpinned_owner_claim ? { ALLOW_UNPINNED_OWNER_CLAIM = "true" } : {},
    var.notification_push_gateway_url != "" ? {
      YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_URL           = var.notification_push_gateway_url
      YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_ALLOWED_HOSTS = local.push_gateway_host
    } : {},
  )
}

# random_bytes, not random_id: random_id exposes its value unmarked (id, hex,
# b64_*), so it would print the key into every plan and apply log. These
# attributes are sensitive, and the resources carry no keepers, so neither
# value rotates on a later apply.
resource "random_bytes" "encryption_key" {
  length = 32
}

resource "random_bytes" "session_hash_salt" {
  length = 32
}

resource "cloudflare_d1_database" "database" {
  account_id       = var.cloudflare_account_id
  name             = local.d1_database_name
  read_replication = { mode = "disabled" }
}

resource "cloudflare_workers_kv_namespace" "kv" {
  account_id = var.cloudflare_account_id
  title      = local.kv_namespace_title
}

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = local.r2_media_bucket
}

resource "cloudflare_queue" "delivery" {
  account_id = var.cloudflare_account_id
  queue_name = local.delivery_queue_name
}

resource "cloudflare_queue" "delivery_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = local.delivery_dlq_name
}

resource "cloudflare_workers_script" "worker" {
  account_id          = var.cloudflare_account_id
  script_name         = local.worker_name
  content_file        = local.worker_bundle_path
  content_sha256      = filesha256(local.worker_bundle_path)
  main_module         = "yurucommu-worker.js"
  compatibility_date  = var.worker_compatibility_date
  compatibility_flags = var.worker_compatibility_flags

  # Workers Logs, as in wrangler.jsonc: schema failures are reported there.
  # Spelled out in full because Cloudflare fills every omitted field and the
  # plan would otherwise never converge.
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
    }
  }

  bindings = concat(
    [
      {
        type        = "d1"
        name        = "DB"
        database_id = cloudflare_d1_database.database.id
      },
      {
        type         = "kv_namespace"
        name         = "KV"
        namespace_id = cloudflare_workers_kv_namespace.kv.id
      },
      {
        type        = "r2_bucket"
        name        = "MEDIA"
        bucket_name = cloudflare_r2_bucket.media.name
      },
      {
        type       = "queue"
        name       = "DELIVERY_QUEUE"
        queue_name = cloudflare_queue.delivery.queue_name
      },
      {
        type       = "queue"
        name       = "DELIVERY_DLQ"
        queue_name = cloudflare_queue.delivery_dlq.queue_name
      },
    ],
    [
      for name in sort(keys(local.plain_vars)) : {
        type = "plain_text"
        name = name
        text = local.plain_vars[name]
      }
    ],
    [
      {
        type = "secret_text"
        name = "ENCRYPTION_KEY"
        text = local.encryption_key
      },
      {
        type = "secret_text"
        name = "YURUCOMMU_SESSION_HASH_SALT"
        text = local.session_hash_salt
      },
    ],
    var.auth_password_hash != "" ? [
      {
        type = "secret_text"
        name = "AUTH_PASSWORD_HASH"
        text = var.auth_password_hash
      },
    ] : [],
    var.notification_push_gateway_token != "" ? [
      {
        type = "secret_text"
        name = "YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_TOKEN"
        text = var.notification_push_gateway_token
      },
    ] : [],
  )

  lifecycle {
    # An install nobody can enter is healthy-looking and useless.
    precondition {
      condition     = var.auth_password_hash != "" || local.has_oidc
      error_message = "Yurucommu needs a sign-in method: auth_password_hash, or a complete Takosumi Accounts OIDC issuer and client id."
    }

    # The Worker mints actor ids and the OIDC redirect from APP_URL; a URL that
    # does not reach this Worker would federate and redirect to the wrong host.
    precondition {
      condition     = !local.app_on_workers || var.cloudflare_workers_subdomain == "" || var.app_url == local.workers_dev_url
      error_message = "A workers.dev app_url must be exactly https://<worker_name>.<cloudflare_workers_subdomain>.workers.dev."
    }

    precondition {
      condition     = local.custom_domain == "" || var.cloudflare_zone_id != ""
      error_message = "A custom app_url hostname needs cloudflare_zone_id for the zone that holds it."
    }

    precondition {
      condition     = var.takosumi_accounts_redirect_uri == "" || var.takosumi_accounts_redirect_uri == "${local.launch_url}/api/auth/callback/takos"
      error_message = "takosumi_accounts_redirect_uri must be app_url + /api/auth/callback/takos, which is the redirect the Worker sends."
    }

    precondition {
      condition     = var.notification_push_gateway_token == "" || var.notification_push_gateway_url != ""
      error_message = "notification_push_gateway_token requires notification_push_gateway_url."
    }
  }
}

resource "cloudflare_queue_consumer" "delivery" {
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.delivery.queue_id
  script_name       = cloudflare_workers_script.worker.script_name
  type              = "worker"
  dead_letter_queue = cloudflare_queue.delivery_dlq.queue_name

  settings = {
    batch_size       = 10
    max_retries      = 3
    max_wait_time_ms = 1000
  }
}

# The DLQ consumer is repair work, not an idle backlog: the Worker recovers
# dead-lettered federation deliveries and push outbox rows from it.
resource "cloudflare_queue_consumer" "delivery_dlq" {
  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.delivery_dlq.queue_id
  script_name = cloudflare_workers_script.worker.script_name
  type        = "worker"

  settings = {
    batch_size       = 10
    max_retries      = 1
    max_wait_time_ms = 60000
  }
}

# Retention sweep (delivery/session/call/media purges). Hourly, matching
# wrangler.jsonc and the Bun self-host interval; each pass is LIMIT-bounded.
resource "cloudflare_workers_cron_trigger" "retention" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.worker.script_name

  schedules = [
    {
      cron = "0 * * * *"
    },
  ]
}

# Managed in both cases so a custom-domain instance explicitly does NOT answer
# on workers.dev.
resource "cloudflare_workers_script_subdomain" "worker" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.worker.script_name
  enabled          = local.app_on_workers
  previews_enabled = false
}

resource "cloudflare_workers_custom_domain" "app" {
  count      = local.custom_domain != "" ? 1 : 0
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = local.custom_domain
  service    = cloudflare_workers_script.worker.script_name
}
