# Yurucommu native smoke stream ownership — 2026-10-01

Scope: Yurucommu only, stacked after qualified PR #54, commit 2481702.
The implementation worker owns native-runtime-stdio.mjs and its declaration,
smoke-release-worker.mjs, smoke-release-browser.mjs and release-worker-smoke.test.ts.
The parent owns this ledger, serial validation and integration handoff. Independent
reviewers have no source edits. Yurumeet remains at its qualified PR #28; its next
update/restore unit is separate. Original dirty trees, shared Core/control and
other worktrees remain read-only. No dependency, app runtime, resource contract,
schema, identity or credential change is part of this unit.

Miniflare 4.20260721.0 passes intermediary streams to handleRuntimeStdio. Its
runtime disposal destroys upstream process pipes but leaves those callback streams
attached to the diagnostic destination. Six native fixtures, each piping two
streams, leave twelve destination listeners of each affected type. The exact Bun
1.3.14 topology probe observed 0 → 12 → 12 after upstream destruction → 0 after
explicit callback-stream unpipe/destroy. This explains the measured listener
retention; it does not establish the cause of the earlier CI child timeout.

Own every callback stream, including rebuilds, and pipe diagnostics with end:false.
The managed runtime must stop attachment before awaiting disposal, release all
streams after success or failure, clean constructor failures, and cache disposal
so the runtime is disposed once. Late callbacks must attempt both releases even
if the first fails. Keep the constructor/runtime/body error primary; successful
work followed by cleanup failure must still fail. Do not close shared stderr,
suppress warnings, raise listener limits or send runtime diagnostics to stdout.
Preserve native assertions, child deadlines and browser cleanup ordering.

Acceptance: real-stream light regressions cover diagnostic bytes, listener
restoration, constructor/disposal/cleanup failures, repeated callbacks/disposal
and late callbacks. Independently compare the old stream topology with the new
helper. Run explicit bun run fmt, then read-only bun run check, fresh native
smoke and actual local browser smoke serially, with a fresh process scan before
each heavy operation. Browser checker changes require fresh browser evidence;
do not reuse PR #54's local browser result as this unit's execution. Qualify the
CI artifact independently, and compare the actual CI checkout tree with the
reviewed commit. Freeze canonical sorted tracked/nonignored file fingerprints
before/after validation, staging and commit. Preserve original dirty snapshots.

Source/local/CI checks do not prove public install, deployed lifecycle, actual
Secret custody, authentication integration or recovery. Atomic initial OIDC owner
claim remains a shared-Core proposal. Yurucommu remains one human's personal
deployment; own personas and external participants are distinct from owners.
No live deployment, permission grant, billing, data deletion, merge, tag or
package publication is authorized by this unit. Return its reviewed commit/PR
and exact proof with remaining GA dependencies to the integration handoff.
