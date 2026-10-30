# Every provider is mocked and every run is plan-only. These checks never
# contact Cloudflare or create/destroy cloud resources. They read the real
# source-built Worker at .generated/yurucommu-worker.js, so `bun run
# check:opentofu` builds and stages it first.
mock_provider "cloudflare" {}
mock_provider "random" {}

variables {
  cloudflare_account_id        = "00000000000000000000000000000000"
  cloudflare_workers_subdomain = "example-sub"
  project_name                 = "yc-test"
  auth_password_hash           = "test-only-bootstrap-credential"
}

run "workers_dev_install_with_password" {
  command = plan

  assert {
    condition     = output.launch_url == "https://yc-test.example-sub.workers.dev"
    error_message = "An empty app_url must derive the workers.dev URL from the Worker name and the connection's subdomain."
  }

  assert {
    condition     = output.api_url == "https://yc-test.example-sub.workers.dev/api"
    error_message = "api_url must be launch_url + /api."
  }

  assert {
    condition = {
      for binding in cloudflare_workers_script.worker.bindings :
      binding.name => binding.text if binding.type == "plain_text"
      } == {
      APP_URL                            = "https://yc-test.example-sub.workers.dev"
      DELIVERY_QUEUE_NAME                = "yc-test-delivery"
      DELIVERY_DLQ_NAME                  = "yc-test-delivery-dlq"
      YURUCOMMU_RUNTIME_LANE             = "cloudflare"
      YURUCOMMU_APPLY_BUNDLED_MIGRATIONS = "true"
    }
    error_message = "A password install must declare exactly the raw cloudflare lane, Worker-applied schema, its URL, and its queue identities as plain variables."
  }

  assert {
    condition = sort([
      for binding in cloudflare_workers_script.worker.bindings :
      binding.name if binding.type == "secret_text"
    ]) == tolist(["AUTH_PASSWORD_HASH", "ENCRYPTION_KEY", "YURUCOMMU_SESSION_HASH_SALT"])
    error_message = "The key, salt, and password must be the only secrets, and all of them secret_text."
  }

  assert {
    condition = {
      for binding in cloudflare_workers_script.worker.bindings :
      binding.name => binding.type
      if contains(["DB", "KV", "MEDIA", "DELIVERY_QUEUE", "DELIVERY_DLQ"], binding.name)
      } == {
      DB             = "d1"
      KV             = "kv_namespace"
      MEDIA          = "r2_bucket"
      DELIVERY_QUEUE = "queue"
      DELIVERY_DLQ   = "queue"
    }
    error_message = "The runtime connections must be the product contract's raw Cloudflare bindings."
  }

  assert {
    condition = (
      cloudflare_d1_database.database.name == "yc-test-db" &&
      cloudflare_workers_kv_namespace.kv.title == "yc-test-kv" &&
      cloudflare_r2_bucket.media.name == "yc-test-media" &&
      cloudflare_queue.delivery.queue_name == "yc-test-delivery" &&
      cloudflare_queue.delivery_dlq.queue_name == "yc-test-delivery-dlq" &&
      cloudflare_workers_script.worker.script_name == "yc-test"
    )
    error_message = "Every resource name must derive from project_name."
  }

  assert {
    condition     = cloudflare_queue_consumer.delivery.dead_letter_queue == "yc-test-delivery-dlq" && cloudflare_queue_consumer.delivery.settings.max_retries == 3
    error_message = "The delivery consumer must dead-letter into the DLQ after three retries."
  }

  assert {
    condition     = cloudflare_queue_consumer.delivery_dlq.dead_letter_queue == null && cloudflare_queue_consumer.delivery_dlq.settings.max_retries == 1
    error_message = "The DLQ needs its own repair consumer and no further dead-letter queue."
  }

  assert {
    condition     = [for schedule in cloudflare_workers_cron_trigger.retention.schedules : schedule.cron] == ["0 * * * *"]
    error_message = "The retention sweep must run hourly."
  }

  assert {
    condition     = length(cloudflare_workers_script_subdomain.worker) == 1 && length(cloudflare_workers_custom_domain.app) == 0
    error_message = "A workers.dev install must enable workers.dev and attach no custom domain."
  }

  assert {
    condition     = cloudflare_workers_script.worker.compatibility_date == "2026-07-16" && cloudflare_workers_script.worker.compatibility_flags == toset(["nodejs_compat", "global_fetch_strictly_public"])
    error_message = "The runtime must match the official wrangler.jsonc deployment."
  }

  assert {
    condition     = cloudflare_workers_script.worker.main_module == "yurucommu-worker.js" && cloudflare_workers_script.worker.content_sha256 == filesha256(".generated/yurucommu-worker.js")
    error_message = "The module must upload exactly the staged source-built Worker."
  }
}

run "no_sign_in_method_is_refused" {
  command = plan
  variables {
    auth_password_hash = ""
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "oidc_only_without_owner_pin_or_acknowledgement_is_refused" {
  command = plan
  variables {
    auth_password_hash           = ""
    takosumi_accounts_issuer_url = "https://accounts.example.test"
    takosumi_accounts_client_id  = "client-test"
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "oidc_only_with_acknowledgement" {
  command = plan
  variables {
    auth_password_hash             = ""
    app_url                        = "https://yc-test.example-sub.workers.dev"
    takosumi_accounts_url          = "https://accounts.example.test"
    takosumi_accounts_issuer_url   = "https://accounts.example.test"
    takosumi_accounts_client_id    = "client-test"
    takosumi_accounts_redirect_uri = "https://yc-test.example-sub.workers.dev/api/auth/callback/takos"
    allow_unpinned_owner_claim     = true
  }

  assert {
    condition = {
      for binding in cloudflare_workers_script.worker.bindings :
      binding.name => binding.text
      if contains(["TAKOSUMI_ACCOUNTS_ISSUER_URL", "TAKOSUMI_ACCOUNTS_CLIENT_ID", "ALLOW_UNPINNED_OWNER_CLAIM"], binding.name)
      } == {
      TAKOSUMI_ACCOUNTS_ISSUER_URL = "https://accounts.example.test"
      TAKOSUMI_ACCOUNTS_CLIENT_ID  = "client-test"
      ALLOW_UNPINNED_OWNER_CLAIM   = "true"
    }
    error_message = "OIDC delivery and the explicit owner acknowledgement must reach the Worker."
  }

  assert {
    condition     = !contains([for binding in cloudflare_workers_script.worker.bindings : binding.name], "AUTH_PASSWORD_HASH")
    error_message = "An OIDC-only install must not bind an empty password."
  }
}

run "pinned_owner_does_not_open_the_owner_race" {
  command = plan
  variables {
    auth_password_hash           = ""
    takosumi_accounts_issuer_url = "https://accounts.example.test"
    takosumi_accounts_client_id  = "client-test"
    oidc_owner_sub               = "pairwise-owner"
    allow_unpinned_owner_claim   = true
  }

  assert {
    condition = (
      contains([for binding in cloudflare_workers_script.worker.bindings : binding.name], "OIDC_OWNER_SUB") &&
      !contains([for binding in cloudflare_workers_script.worker.bindings : binding.name], "ALLOW_UNPINNED_OWNER_CLAIM")
    )
    error_message = "A pinned owner must win over the unpinned acknowledgement."
  }
}

run "redirect_uri_must_match_the_worker_callback" {
  command = plan
  variables {
    takosumi_accounts_issuer_url   = "https://accounts.example.test"
    takosumi_accounts_client_id    = "client-test"
    takosumi_accounts_redirect_uri = "https://elsewhere.example.test/api/auth/callback/takos"
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "workers_dev_app_url_must_reach_this_worker" {
  command = plan
  variables {
    app_url = "https://other-name.example-sub.workers.dev"
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "app_url_must_be_a_bare_origin" {
  command = plan
  variables {
    app_url = "https://yc-test.example-sub.workers.dev/"
  }
  expect_failures = [var.app_url]
}

run "url_needs_app_url_or_subdomain" {
  command = plan
  variables {
    cloudflare_workers_subdomain = ""
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "custom_domain_needs_a_zone" {
  command = plan
  variables {
    app_url = "https://social.example.com"
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "custom_domain_is_attached" {
  command = plan
  variables {
    app_url            = "https://social.example.com"
    cloudflare_zone_id = "11111111111111111111111111111111"
  }

  assert {
    condition     = cloudflare_workers_custom_domain.app[0].hostname == "social.example.com" && cloudflare_workers_custom_domain.app[0].zone_id == "11111111111111111111111111111111"
    error_message = "A custom app_url host must be attached as a Workers Custom Domain in the given zone."
  }

  assert {
    condition     = output.launch_url == "https://social.example.com"
    error_message = "launch_url must be the custom origin."
  }
}

run "supplied_secrets_are_exact_secret_text" {
  command = plan
  variables {
    encryption_key    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    session_hash_salt = "existing-instance-session-salt-value"
  }

  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker.bindings :
      binding.type == "secret_text" && binding.text == (binding.name == "ENCRYPTION_KEY" ? var.encryption_key : var.session_hash_salt)
      if contains(["ENCRYPTION_KEY", "YURUCOMMU_SESSION_HASH_SALT"], binding.name)
    ])
    error_message = "An adopted key and salt must reach the Worker byte-for-byte as secret_text."
  }
}

run "boundary_whitespace_password_is_refused" {
  command = plan
  variables {
    auth_password_hash = " aa:bb "
  }
  expect_failures = [var.auth_password_hash]
}

run "push_gateway_token_requires_url" {
  command = plan
  variables {
    notification_push_gateway_token = "test-only-token"
  }
  expect_failures = [cloudflare_workers_script.worker]
}
