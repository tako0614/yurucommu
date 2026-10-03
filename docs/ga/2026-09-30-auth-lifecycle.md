# Native password session lifecycle — 2026-09-30

Task: `GA-20260930-password-session-lifecycle`.

Scope/order: the two products in their separate assigned worktrees and separate
stacked PRs after Yurucommu #42 / Yurumeet #15. Parent owns the product smoke
helpers/tests; no original dirty install or Unicode-search work is changed.
Implement and independently review, run complete owner gates serially with a
free heavy-build slot, then return exact heads/CI and remaining dependencies.

Acceptance candidates: invalid password creates/replaces no session; actual
password login returns a secure HttpOnly scoped cookie and creates a salted
session row for the existing owner, rotates the prior session and rejects its
cookie; DM/media use the newly issued cookie; logout removes that exact row
and rejects replay, DM/media writes and private-media reads while preserving
other sessions and actor IDs/roles. Successful HTTP or
a clearing cookie alone cannot pass missing/no-op durable effects. Private-media
denials require no-store and an error-only JSON body with a known fixed refusal
reason; a 403 response containing image bytes cannot pass.

Qualify both PBKDF2 and colonless bootstrap password paths against the published
locked Core, in separate disposable native Miniflare stores. Values are local
synthetic fixtures, never real credentials or new authentication permissions.
No Core/API pins, login providers, authorization rules, schemas, cloud resources
or deployment settings change. The owner is seeded to avoid claiming first-owner
provisioning/key generation. Recipient/unrelated sessions remain test fixtures.

This proves local native artifact login/session rotation/logout and consequent
API use. It does not qualify OIDC/provider callbacks, native/mobile bearer
clients, browser cookie enforcement, managed install, real production identity,
remote federation, lifecycle, DR or monitoring. The family GA goal remains
active until those requirements have direct current evidence. No publication,
production deploy, new billing/rights, real salt rotation or destructive data
operation is performed; logout removes only disposable test session rows.

Local complete gate: Bun 1.3.14 / OpenTofu 1.12.3, 433 passed / 0 failed
and 6 mock-provider plan tests passed. Native artifact smoke passed both
password methods. All tracked/new source checksums matched before and after
the read-only gate. This result paragraph is the only source addition afterward.
Independent read-only review is complete; initial fake-login/logout and
private-byte denial mutants reproduced the old false green before correction.
Exact-head CI and live qualification are separate evidence.
