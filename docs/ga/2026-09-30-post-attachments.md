# Native post attachments and visibility — 2026-09-30

Task: `GA-20260930-post-attachments`.

Scope/order: implement the product-owned artifact journey in each separate
assigned worktree, stack after Yurucommu #43 / Yurumeet #16, independently review,
then run complete owner gates serially and return exact heads/CI/dependencies.
Parent owns scripts/release-post-journey.mjs, the product journey and its smoke
tests. Original install and Unicode-search work remains outside this unit.

Acceptance candidates: the actual password-issued owner session uploads distinct
PNG images for public and followers posts. Use the UI attachment payload and
public default; require Note/owner/visibility/attachment agreement across POST,
SQL and GET, correlated outbound Create and durable followers fanout intent,
ActivityPub Document/absolute URL/alt text without internal storage keys, exact
public image bytes/cache policy, unsigned followers ActivityPub refusal and
followers image refusal to anonymous and unrelated actors. Preserve existing unattached/private and revoked-cookie
checks and refuse anonymous/revoked post writes without durable effects.

Fixtures have no followers or mentions; no actual external delivery is performed.
Only native disposable stores and internal queue wakeups are exercised. The two
locked Core create/read paths agree; deletion differs between versions and is
outside this unit. No Core/API/provider pin, schema, authorization, installation,
deployment, production resource or real-data change is introduced. Shared defects
are proposals to the principal, never edits to common owner repositories.

Source/native artifact and CI evidence remain separate from package publication,
managed install, real cross-server federation, live browser/native journeys,
lifecycle, recovery and monitoring. Those remain necessary evidence for the full
family GA goal. No new billing, rights, deploy or destructive real-data operation.

Local complete gate: Bun 1.3.14 / OpenTofu 1.12.3, 442 passed / 0 failed
and 6 mock-provider plan tests passed. Full gates ran serially after an empty
global full-check slot; all tracked/new source checksums matched before/after.
This result paragraph is the only source addition afterward. Independent
read-only review is complete with no remaining finding. Nine targeted artifact
mutants all reproduced false green with the previous committed journey
(0 passed / 9 expected-failure tests failed), then were rejected by the new
journey. Both native password fixture methods passed. Exact-head CI, published
bytes and live qualification remain separate evidence.

Yurucommu acceptance also requires its single-owner product premise: personal
self-deployment, exactly one root owner at first setup and afterward, personas
belonging to that owner, and communication peers without instance ownership
or local session authority. Synthetic local member fixtures qualify only
authorization invariants. First-owner and remote participation proof remain
separate requirements; see ../product/single-owner.md. This Yurucommu premise
is not a new Yurumeet condition.
