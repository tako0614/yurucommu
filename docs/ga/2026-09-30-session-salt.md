# Production session salt adapter contract — 2026-09-30

Task: `GA-20260930-session-salt-adapters`.

Products and sequence: Yurucommu and Yurumeet, each in its assigned worktree and
separate PR, stacked after its authenticated artifact-journey PR. Implement the
direct adapter and fresh portable install declaration, obtain independent
review, run complete owner gates serially with a free build slot, then return
exact commits/CI and unresolved shared dependencies to integration.

Ownership: product HCL, manifest, release validation, tests and docs only. The
published Core production MUST contract already names
`YURUCOMMU_SESSION_HASH_SALT`; its fallback and readiness remain unchanged.
No original dirty install/search changes, other worktrees or shared repos are
edited. No new login method, identity, permissions, credentials or cloud target
is created. All salt values in tests are synthetic and disposable.

Acceptance: an enabled direct Worker requires a nonblank sensitive salt input,
projects exactly one `secret_text` binding with the original bytes, and rejects
the same name in plaintext `env`. Metadata/backing-resource-only modes require
no salt. Portable WorkerVersion and binding-delivered generated-secret metadata
declare the same exact required name set. Yurucommu's disposable portable E2E
keeps encryption key and salt unchanged across the normal OIDC update.

Evidence is source/local mocked plans/CI only. Actual production configuration
has not been inspected, so missing live salt is not claimed. Mock providers and
plan-only tests cannot create/destroy cloud resources. A length/format check is
not entropy proof; real values must come from an operator's secure generator.

## Integration and operational dependencies

Adding a portable generated secret changes the Takosumi runtime profile. Its
current sealed-input materializer retires the previous generation and may
regenerate existing ENCRYPTION_KEY along with the new salt. This source unit
declares the fresh-install contract; it is not an authorized or qualified
existing-Capsule update. Before any such Apply the principal/platform owner must
establish existing secret custody and preserve existing encryption/session
values or supply an explicitly reviewed migration/recovery plan. Do not treat
the disposable E2E's preservation as proof of platform materializer preservation.

The direct OpenTofu adapter accepts an operator-owned sensitive input. Existing
Takosumi root metadata does not supply a sealed user-secret input for it; do not
expose the salt through an ordinary install field or plaintext variable to work
around that dependency. Managed direct install requires its owner to implement
and qualify the sealed delivery path. Manual self-host and the portable
binding-delivered declaration are separate paths.

Salt introduction/rotation changes persisted session lookup and can require
re-login. Current custody, exact secret-channel delivery, real login/readback,
and re-login/recovery procedure remain operational release conditions. No live
salt rotation, data/session deletion, deployment or publication is performed.

## Verified source results

- Old HEAD module in an isolated operator directory: two metadata/backing-only
  plans passed, then the enabled Worker incorrectly accepted missing salt.
  The new expected-failure test was red (2 passed / 1 failed; later cases
  skipped). All providers were mocked, every run was plan-only.
- Final owner `bun run check`, Bun 1.3.14 / OpenTofu 1.12.3: **427 passed /
  0 failed** plus **6 mocked OpenTofu plans passed / 0 failed**. Format, types,
  published-Core checks, native/portable builds, portable contract tests and
  complete artifact smoke passed. Hashes for all tracked/new source inputs
  matched before and after the read-only gate.
- Dedicated salt retains intentional whitespace exactly; missing/whitespace-only
  values and plaintext env are refused. Release readiness requires the secret,
  preserves its original bytes and excludes it from rendered plaintext config.
- Independent read-only review found no blocking source defect. Its limitations
  match the custody/materializer and managed direct delivery dependencies above.

Exact commit, CI results and logs are returned in the family session-salt handoff.
Local log: `/root/hdd/takos-dev/operator-runs/yuru-family-ga-session-salt-20260930/yurucommu-check.log`.
No install, portable Host execution, real login or current live claim is made.
