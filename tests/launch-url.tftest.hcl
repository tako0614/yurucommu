# Evaluate the real root module with mocked providers, never a live account.
# Only the managed fixture uses apply, to retain mock state for its no-op plan.
mock_provider "cloudflare" {}
mock_provider "http" {}
mock_provider "random" {}

variables {
  cloudflare_workers_subdomain = "example-sub"
}

run "metadata_without_worker_does_not_invent_a_launcher" {
  command = plan

  assert {
    condition     = length(cloudflare_workers_script.worker) == 0 && !output.worker_managed_by_opentofu
    error_message = "Default root inputs must not create a Worker."
  }
  assert {
    condition     = output.launch_url == null && output.api_url == null
    error_message = "A subdomain alone must not advertise an unmanaged Worker URL."
  }
}

run "backing_resources_without_worker_do_not_invent_a_launcher" {
  command = plan
  variables {
    enable_cloudflare_resources = true
    cloudflare_account_id       = "00000000000000000000000000000000"
  }

  assert {
    condition     = length(cloudflare_d1_database.database) == 1 && length(cloudflare_workers_script.worker) == 0
    error_message = "Backing resources alone must not imply a deployed Worker."
  }
  assert {
    condition     = output.launch_url == null && output.api_url == null
    error_message = "Backing resources alone must not advertise a Worker URL."
  }
}

run "explicit_existing_instance_reference_is_preserved" {
  command = plan
  variables {
    app_url = "https://existing.example.test"
  }

  assert {
    condition     = length(cloudflare_workers_script.worker) == 0 && !output.worker_managed_by_opentofu
    error_message = "Referencing an existing instance must not create a Worker."
  }
  assert {
    condition     = output.launch_url == "https://existing.example.test" && output.api_url == "https://existing.example.test/api"
    error_message = "An explicit external instance URL must remain available as a reference."
  }
}

run "managed_worker_has_a_launcher" {
  command = apply
  variables {
    enable_cloudflare_resources     = true
    enable_cloudflare_worker_script = true
    cloudflare_account_id           = "00000000000000000000000000000000"
    worker_bundle_path              = "tests/fixtures/session-salt-worker.js"
    worker_release_tag              = ""
    worker_bundle_url               = ""
    worker_bundle_sha256            = ""
    encryption_key                  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    auth_password_hash              = "test-only-bootstrap-credential"
    session_hash_salt               = "test-only-fixture-session-salt"
  }

  assert {
    condition     = length(cloudflare_workers_script.worker) == 1 && output.worker_managed_by_opentofu
    error_message = "The managed fixture must actually include a Worker."
  }
  assert {
    condition     = output.launch_url == "https://yurucommu.example-sub.workers.dev" && output.api_url == "https://yurucommu.example-sub.workers.dev/api"
    error_message = "The managed Worker must retain its derived launcher URL."
  }
}

run "existing_managed_worker_noop_retains_its_launcher" {
  command = plan
  variables {
    enable_cloudflare_resources     = true
    enable_cloudflare_worker_script = true
    cloudflare_account_id           = "00000000000000000000000000000000"
    worker_bundle_path              = "tests/fixtures/session-salt-worker.js"
    worker_release_tag              = ""
    worker_bundle_url               = ""
    worker_bundle_sha256            = ""
    encryption_key                  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    auth_password_hash              = "test-only-bootstrap-credential"
    session_hash_salt               = "test-only-fixture-session-salt"
  }

  assert {
    condition     = output.launch_url == "https://yurucommu.example-sub.workers.dev" && output.api_url == "https://yurucommu.example-sub.workers.dev/api"
    error_message = "An unchanged managed instance must retain its existing launcher outputs."
  }
  assert {
    condition     = length(cloudflare_workers_script.worker) == 1 && output.worker_managed_by_opentofu
    error_message = "A managed no-op must not be confused with metadata-only mode."
  }
}
