# Every provider is mocked and every run is plan-only. These checks never
# contact Cloudflare or create/destroy cloud resources.
mock_provider "cloudflare" {}
mock_provider "http" {}
mock_provider "random" {}

variables {
  enable_cloudflare_resources     = true
  enable_cloudflare_worker_script = true
  cloudflare_account_id           = "00000000000000000000000000000000"
  worker_bundle_path              = "tests/fixtures/session-salt-worker.js"
  worker_release_tag              = ""
  worker_bundle_url               = ""
  worker_bundle_sha256            = ""
  app_url                         = "https://session-salt.example.test"
  encryption_key                  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  auth_password_hash              = "test-only-bootstrap-credential"
}

run "metadata_without_salt" {
  command = plan
  variables {
    enable_cloudflare_resources     = false
    enable_cloudflare_worker_script = false
  }
  assert {
    condition     = length(cloudflare_workers_script.worker) == 0
    error_message = "Metadata-only mode must not create a Worker or require runtime salt."
  }
}

run "resources_without_worker_or_salt" {
  command = plan
  variables {
    enable_cloudflare_worker_script = false
  }
  assert {
    condition     = length(cloudflare_workers_script.worker) == 0
    error_message = "Backing resources alone must not create a Worker or require runtime salt."
  }
}

run "enabled_worker_requires_salt" {
  command         = plan
  expect_failures = [cloudflare_workers_script.worker]
}

run "plaintext_salt_is_refused" {
  command = plan
  variables {
    env = {
      YURUCOMMU_SESSION_HASH_SALT = "test-only-plaintext-salt"
    }
  }
  expect_failures = [var.env]
}

run "blank_salt_is_refused" {
  command = plan
  variables {
    session_hash_salt = " \n\t "
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "dedicated_salt_is_exact_secret_text" {
  command = plan
  variables {
    session_hash_salt = "  test-only-salt-with-intentional-spaces  "
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "YURUCOMMU_SESSION_HASH_SALT"
    ]) == 1
    error_message = "The session salt must have exactly one Worker binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.session_hash_salt
      if binding.name == "YURUCOMMU_SESSION_HASH_SALT"
    ])
    error_message = "The salt must use secret_text and preserve its exact bytes."
  }
}
