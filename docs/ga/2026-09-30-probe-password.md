# Verbatim probe password — 2026-09-30

Task: `GA-20260930-probe-password-input`.

Scope/order: both products, each in its assigned worktree and separate PR;
this yurucommu unit stacks after #44. Parent owns the probe CLI, new
black-box regression tests, package test registration and this ledger.
Protect original install/message-search differences and other worktrees.
Reproduce, fix, independently review, run complete owner gates serially with
a free global check slot, then return exact-head CI and dependencies.

The published locked Core password contract preserves every nonempty input.
The CLI environment reader trimmed valid credentials; Yurumeet additionally
rejected internal newlines. Password inputs now preserve raw environment
strings. Existing missing/empty handling and path/cookie normalization remain.
No auth permissions, stored credential, Core/API/provider pin, Terraform,
schema or deployment setting changes.

Eight black-box cases spawn the actual CLI against a disposable loopback HTTP
fixture. Capture login JSON for surrounding spaces, whitespace only, boundary
tabs, internal CRLF, Unicode whitespace and an ordinary control; preserve the
exact value. Missing/empty inputs must not issue login. The fixture supplies
only prerequisite GETs and returns fixed 401 immediately after recording the
login POST. Require refusal, no success output, no session/actor readback or
subsequent CRUD/delete. No real service or credential is used.

Baseline evidence: Yurucommu 4 passed / 4 failed; Yurumeet 3 passed / 5 failed.
These prove serialization/early-refusal bugs in the old actual entrypoints,
not a Core login failure or a live qualification. New tests are part of each
complete portable gate. Source, exact-head CI and native/browser/live evidence
remain separate. The family GA goal still requires managed install, actual
remote delivery, lifecycle, recovery, monitoring and native/OIDC proof.

Root Terraform bootstrap-token normalization remains a separate candidate
requiring compatibility and blank-disabled semantics review. No production
deploy, new billing/authentication rights, real credential rotation or
destructive real-data operation is performed. Test cleanup removes only files
created in that test's fresh temporary directory.

Verified local full gate: 450 tests passed / 0 failed plus 6 mock-provider
plans passed, with source hashes unchanged. The isolated new CLI cases pass
8 / 0; old committed CLI is red at 4 / 4. Independent read-only review closed
the ambient-child-env isolation finding. Child env now contains only the
fixture outputs file and the tested password; dotenv loading is disabled.
Local Worker SHA-256 is
`b0d1d40893a664b8030ddd9a2a003beb350f0394d1d705814b1ada88c2a391dc`.
The ledger result paragraph was added after the local gate; exact-head CI
qualifies the resulting commit independently. No compiled artifact is staged.
