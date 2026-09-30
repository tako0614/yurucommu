# Every provider is mocked and every run is plan-only. These tests never
# contact a cloud service, issue credentials or mutate deployed resources.
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
  app_url                         = "https://auth-input.example.test"
  encryption_key                  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  session_hash_salt               = "test-only-high-entropy-fixture-salt"
}

run "ordinary_bootstrap" {
  command = plan
  variables {
    auth_password_hash = "test-only-token"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "boundary_spaces" {
  command = plan
  variables {
    auth_password_hash = "  test-only-token  "
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "tabs_and_crlf" {
  command = plan
  variables {
    auth_password_hash = "\ttest-only\r\n-token\t"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "unicode_spaces" {
  command = plan
  variables {
    auth_password_hash = "\u00a0test-only-token\u3000"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "feff_boundary" {
  command = plan
  variables {
    auth_password_hash = "\ufefftest-only-token\ufeff"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "nel_boundary" {
  command = plan
  variables {
    auth_password_hash = "\u0085test-only-token\u0085"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "canonical_pbkdf2" {
  command = plan
  variables {
    auth_password_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "odd_hex_is_bootstrap" {
  command = plan
  variables {
    auth_password_hash = "  aab:bb  "
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
}

run "hcl_nfc_string" {
  command = plan
  variables {
    auth_password_hash = "test-e\u0301"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 1
    error_message = "Password auth must have exactly one binding."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      binding.type == "secret_text" && binding.text == var.auth_password_hash
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "The binding must preserve the HCL string value as secret_text."
  }
  # cty NFC normalization happens before adapter evaluation. Assert bytes,
  # rather than comparing two literals normalized by the same HCL parser.
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings :
      base64encode(binding.text) == "dGVzdC3DqQ=="
      if binding.name == "AUTH_PASSWORD_HASH"
    ])
    error_message = "This input path qualifies an NFC HCL string, not original Unicode bytes."
  }
}

run "padded_pbkdf2_refused" {
  command = plan
  variables {
    auth_password_hash = "  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  "
  }
  expect_failures = [var.auth_password_hash]
}

run "feff_padded_pbkdf2_refused" {
  command = plan
  variables {
    auth_password_hash = "\ufeffaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ufeff"
  }
  expect_failures = [var.auth_password_hash]
}

run "empty_without_oidc_refused" {
  command = plan
  variables {
    auth_password_hash = ""
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "ascii_blank_without_oidc_refused" {
  command = plan
  variables {
    auth_password_hash = " \t\r\n "
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "feff_blank_without_oidc_refused" {
  command = plan
  variables {
    auth_password_hash = "\ufeff \ufeff"
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "nel_blank_without_oidc_refused" {
  command = plan
  variables {
    auth_password_hash = "\u0085"
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "partial_oidc_without_password_refused" {
  command = plan
  variables {
    auth_password_hash           = ""
    takosumi_accounts_issuer_url = "https://accounts.example.test"
    oidc_owner_sub               = "test-only-owner"
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "empty_with_oidc_omits_password" {
  command = plan
  variables {
    auth_password_hash           = ""
    takosumi_accounts_issuer_url = "https://accounts.example.test"
    takosumi_accounts_client_id  = "test-only-client"
    oidc_owner_sub               = "test-only-owner"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 0
    error_message = "Blank password inputs must be omitted even with complete OIDC."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if contains(["TAKOSUMI_ACCOUNTS_ISSUER_URL", "TAKOSUMI_ACCOUNTS_CLIENT_ID", "OIDC_OWNER_SUB"], binding.name)
    ]) == 3
    error_message = "Complete OIDC and the explicit owner pin must remain projected."
  }
}

run "ascii_blank_with_oidc_omits_password" {
  command = plan
  variables {
    auth_password_hash           = " \t\r\n "
    takosumi_accounts_issuer_url = "https://accounts.example.test"
    takosumi_accounts_client_id  = "test-only-client"
    oidc_owner_sub               = "test-only-owner"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 0
    error_message = "Blank password inputs must be omitted even with complete OIDC."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if contains(["TAKOSUMI_ACCOUNTS_ISSUER_URL", "TAKOSUMI_ACCOUNTS_CLIENT_ID", "OIDC_OWNER_SUB"], binding.name)
    ]) == 3
    error_message = "Complete OIDC and the explicit owner pin must remain projected."
  }
}

run "feff_blank_with_oidc_omits_password" {
  command = plan
  variables {
    auth_password_hash           = "\ufeff \ufeff"
    takosumi_accounts_issuer_url = "https://accounts.example.test"
    takosumi_accounts_client_id  = "test-only-client"
    oidc_owner_sub               = "test-only-owner"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 0
    error_message = "Blank password inputs must be omitted even with complete OIDC."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if contains(["TAKOSUMI_ACCOUNTS_ISSUER_URL", "TAKOSUMI_ACCOUNTS_CLIENT_ID", "OIDC_OWNER_SUB"], binding.name)
    ]) == 3
    error_message = "Complete OIDC and the explicit owner pin must remain projected."
  }
}

run "nel_blank_with_oidc_omits_password" {
  command = plan
  variables {
    auth_password_hash           = "\u0085"
    takosumi_accounts_issuer_url = "https://accounts.example.test"
    takosumi_accounts_client_id  = "test-only-client"
    oidc_owner_sub               = "test-only-owner"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "AUTH_PASSWORD_HASH"
    ]) == 0
    error_message = "Blank password inputs must be omitted even with complete OIDC."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if contains(["TAKOSUMI_ACCOUNTS_ISSUER_URL", "TAKOSUMI_ACCOUNTS_CLIENT_ID", "OIDC_OWNER_SUB"], binding.name)
    ]) == 3
    error_message = "Complete OIDC and the explicit owner pin must remain projected."
  }
}
