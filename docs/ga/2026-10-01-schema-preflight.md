# Direct Worker schema preflight — 2026-10-01

Task: GA-20261001-yuru-schema-preflight. Owner: this Yurucommu product session.
Base: reviewed PR #51, `6ffce32d96dc7fb6b80b20b3c68dd0a1c52d610f`.
Only the assigned Yurucommu worktree changes. Yurumeet's separately qualified
PR #25 is a design reference; shared Core, control, original dirty repositories
and other worktrees remain read-only. This task changes the production release
mechanism, so independent review and the full read-only owner gate are required.
It does not authorize deployment, schema/data mutation or permission changes.

## Gap and intended contract

The code-only direct Cloudflare API publisher currently uploads Core 4.1.11
without proving migration 0030's required deletion-intent structure exists.
Its digest-pinned private config intentionally forbids resource bindings. The
database must therefore come from the exact active predecessor Worker Version
whose bindings the new Version will inherit, using the validated target account.

Before upload, require exactly one concrete D1 binding named `DB` and a fixed
read-only metadata query proving 0030's required columns, primary key and due
index key order. Missing or ambiguous DB, denied/failed API, malformed result
or missing structure must remain `PRE_UPLOAD_FAILURE`, with no Version upload
or Deployment mutation. The existing API token is reused; insufficient scope
blocks the operation without requesting or granting new permissions.

This check covers the named 0030 structure only. It does not establish full
schema fidelity, migration-ledger accuracy, production state or live readiness.
Never apply migrations through the stale live `_cf_migrations` ledger. Other
Cloudflare/Takoform install paths retain their own schema-application contract.
The Yurucommu single-human-owner premise and ownership boundaries are unchanged;
no Yurumeet ownership premise is introduced.

Response metadata remains optional, as in the official D1 API. When supplied,
write flags/counts must have the declared types and cannot report mutation.
Provider diagnostics mask the known token/password and their JSON string forms
before the existing 4,000-character bound, including fetch/body-read failures.
This addresses demonstrated synthetic diagnostic cases, not an observed live
credential leak or a guarantee about arbitrary secret encodings.

## Ownership and acceptance

- Implementation worker: release provider module, declarations and tests;
  product-owned metadata helper/tests and test registration if needed.
- Parent: entrypoint contract, README Japanese/English, this ledger, evidence,
  source freeze, serial full check, commit/PR and integration handoff.
- Independent reviewer: release-mechanism authority, exact DB selection,
  pre-upload failure ordering, diagnostics, inherited binding closure and tests.

Acceptance requires isolated direct-API denial/malformed/missing-schema tests
that make no upload, exact active DB/account targeting, actual SQLite metadata
from the checked-in 0030 SQL, an old-versus-new regression proof, unchanged
source across full `bun run check`, and exact-tree CI. Local/mocked, CI and live
evidence remain separate. Actual token permission and live D1 readiness are
operator dependencies, not claims from these tests.

## Verification

The fixed metadata SQL has passed a separate local Miniflare 4.20260721.0 native
D1 probe on Bun 1.3.14: empty schema is refused; the exact checked-in 0030 SQL
(SHA-256 `8750ebe686d6b6a6330a49873e9ec6358881fdf76b6a1a47444618bbd9464a9d`)
is accepted; the query reports zero writes. The fixture runtime was disposed.
This proves local SQL support, not the public REST response or live DB state.

Focused tests, independent review, old-versus-new regression, source fingerprints,
the full owner gate and exact-tree CI are recorded with their terminal results in
the operator directory and integration handoff, outside the source being checked:
`/root/hdd/takos-dev/operator-runs/yurucommu-ga-schema-preflight-20261001/` and
`/root/hdd/takos-dev/handoffs/yurucommu-ga-schema-preflight-20261001.md`.
No actual Cloudflare API request or deployment is made by these fixtures.
