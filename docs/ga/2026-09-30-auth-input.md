# Direct adapter authentication input — 2026-09-30

Task: `GA-20260930-direct-auth-input`.

Scope/order: both product root Cloudflare adapters, each assigned worktree
and separate PR. This yurucommu unit stacks after #45. Parent owns
main.tf, tests/auth-password.tftest.hcl, package.json, README.md, README.en.md
and this ledger. Original install/message-search dirty work, shared Core and
other worktrees are protected. Do not Apply, rotate actual credentials, deploy,
create resources or change billing/permissions.

Prove plan-only mock-provider red cases before fixing, independently review
credential classification and update compatibility, run complete owner gates
serially in a free global build slot, then return exact-head CI and remaining
GA dependencies. This unit changes configuration semantics, never live state.

Acceptance: ordinary/unambiguous bootstrap input and canonical PBKDF2 input
project the HCL string value as exactly one secret_text binding. Keep existing
HCL blank omission and no-password/partial-OIDC refusal; also omit Core-only
blank values such as FEFF. Complete OIDC retains its issuer, client and owner
pin. Padded PBKDF2-shaped strings must fail before Apply rather than silently
switching to bootstrap verification. Explain existing padded configuration
impact and HCL NFC normalization; do not claim arbitrary original UTF-8 bytes
survive OpenTofu.

Twenty isolated plan runs mock every provider. The new auth test is registered
in the complete gate; explicit bun run fmt also formats these owned HCL files.
Native Core helper classification, HCL plans, artifact checks and live login
are distinct evidence. Managed install/secret preservation, real remote
delivery, lifecycle/recovery/monitoring/native/OIDC qualification still remain.

Independent design review rejected a naive raw-value fix: padded PBKDF2 would
become a bootstrap credential. Variable validation now refuses hash-shaped
padding using the locked Core's nonempty even-length hex:hex classification.
The guard covers HCL and ECMAScript whitespace, including FEFF/NEL boundaries.
No legacy credential compatibility layer or silent hash canonicalization is
added. Existing padded hashes require explicit canonical input before Apply.

Core blank and HCL blank definitions differ. Preserve the existing HCL policy
and also omit Core-only blank values to avoid a Worker with no usable password.
A NEL-only value remains omitted under HCL policy; a FEFF-only value is now
omitted under Core policy. Both require complete OIDC or plan refusal.

References: [OpenTofu trimspace](https://opentofu.org/docs/language/functions/trimspace/),
[ECMAScript trim](https://tc39.es/ecma262/2024/multipage/text-processing.html#sec-string.prototype.trim),
[cty StringVal NFC](https://pkg.go.dev/github.com/zclconf/go-cty/cty#StringVal).
The guarantee is preservation of an HCL string value without additional trim,
not arbitrary original UTF-8 bytes. Existing bootstrap inputs whose projection
changes need credential-owner review before actual Apply; no Apply is performed.

Verified local full owner gate: 450 tests / 0 failures and 26 mock plans
(20 authentication + 6 session-salt), with source hashes unchanged.
Baseline full auth test: 4 passed / 6 failed / 10 skipped after missing
expected-failure checks; do not count skipped cases as tested. Three isolated
old-source FEFF/guard runs were separately red; both source files restored
exactly. Fixed auth plans are 20 / 0 with no skips. Published Core 4.1.11 helper
classification also passed; it is neither an HTTP login nor a live qualification.
Independent read-only review closed the initial credential-reclassification
finding and has no remaining major finding. No actual Apply. The ledger result
paragraph was added after the local gate; exact-head CI qualifies the commit.
