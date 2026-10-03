# Yurucommu publication code readback — 2026-10-01

Scope: Yurucommu only, stacked after qualified #53. Parent owns deploy contract,
release-version contract test, native-smoke test helper and README JA/EN. A bounded implementation worker
owns release-yurucommu-worker.mjs, its declaration and test. An independent reviewer
owns no source edits. Original install work, Meet #28, shared Core/control and
other worktrees remain read-only. Common evidence feedback is in the external
yuru-family-code-byte-proof-gap-20261001.md handoff. No combined product PR.

Version resources.script.etag is an opaque provider value; its hash algorithm and
byte domain are not guaranteed by the API. Remove local SHA256 equality as byte
proof while retaining stable etag identity and all existing source/config/route,
Deployment, non-code closure, active DB/0030 and required session-salt checks.

The product provider must download exact candidate Version module content with a
bounded timed raw multipart reader, requiring exactly one ESM worker.mjs part,
correct cf-entrypoint, byte length and SHA256. Require the capability before
upload, verify after upload and immediately before promotion, then after smoke.
Missing/malformed/changed code refuses without retries or automatic recovery.
Preserve monotonic indeterminate phases once a write was attempted. Never replace
byte proof with an annotation or weaken non-code closure checks.

content/v2?version=UUID follows installed official Wrangler4.107.0 source, which
also uses a text metadata FormData field. Public Content API docs do not specify
that query, so source/mock/CI support is distinct from live API/permission proof.
No new permissions, credentials, Secret/resources/settings/trigger writes,
schema/data mutation, production deploy, billing, merge/tag or immutable release.
Single-owner personal deployment remains Yurucommu's premise; own personas and
remote communication subjects remain distinct. No owner/session data is repaired.

Authority-trigger independent review must cover exact changed source and evidence.
Run explicit bun run fmt and full read-only bun run check before handoff, serial
with other heavy work. Freeze canonical tracked/nonignored source fingerprints.
Reuse prior runtime/browser/update proofs only if exact Worker bytes remain equal,
retaining their old source identity; qualify CI artifact bytes independently.
Preserve original dirty HEAD/status/binary diff and leave worktrees clean at return.

First CI failed an existing native mutant at 20.12s, matching its 20s child
deadline; the expected owner-switch diagnostic was absent. A single operator
probe of the exact fixture with phase-only checker instrumentation completed in
2.78s with the expected refusal and disposal. The CI stall phase remains unknown.
Keep the measured deadline unchanged and require a normal child exit before any
mutant-marker assertion; null exit or signal termination is a harness failure.
An actual self-signaled child printing the expected marker must still be refused.
Preserve the failed CI and first local proof separately, then requalify the changed
test source; do not relabel the earlier CI or claim the CI stall cause is fixed.

Remaining GA conditions include public self-install/Host lifecycle, actual Secret
custody/materializer preservation, OIDC/Takos recovery, atomic first owner, encrypted
OAuth and code rollback. This publisher unit does not complete those conditions.
