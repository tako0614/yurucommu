# Existing-instance session salt and update qualification — 2026-10-01

Task: `GA-20261001-yurucommu-session-update`.

Product and sequence: Yurucommu only, after reviewed clean `4771c134` / PR #52.
The immutable published v2.2.0 artifact (`3eb2c475`, SHA256 `b0d1d408…`)
is the existing-data baseline. Both versions pin Core/API 4.1.11 and schema 29;
this task does not invent a schema migration or republish that existing tag.

Ownership: product binding composition, direct code-only publisher, scoped
regression tests, native existing-data probe and operator instructions. This
changes authentication enforcement and release behavior, requiring independent
review and the complete read-only owner gate before handoff. No Core, control,
Yurumeet, original dirty tree or other worktree is edited. No live credentials,
permissions, cloud resources, deployment, publication or real data are changed.
The Worker and immutable Worker-release deploy surfaces declare `authority`
and independent review; release identity also retains `published-identity` and
its create-only obligation. These declarations do not authorize publication.

The required salt declaration already landed in the preceding adapter work.
This task supersedes that unit's runtime-fallback limitation for Yurucommu:
the runtime composition must refuse missing, blank or known public development-fallback
salt instead of allowing Core to authenticate with it. Accepted bytes are
preserved exactly; a syntax check does not establish entropy. Both binding
lanes and all product invocation paths use the same composition boundary.

Before a direct code-only upload, the exact active predecessor Version must
expose exactly one `YURUCOMMU_SESSION_HASH_SALT` secret binding. The publisher
does not read its value, generate it, rotate it or rewrite sessions. Metadata
alone cannot prove a secret's value or entropy. Refusal remains pre-upload.
For a saltless stable predecessor this intentionally blocks code-only update.
First setting the Secret requires a separate credential-owner-reviewed procedure
and re-authentication using that installation's password or OIDC method. Keep
the new salt through future updates and code rollback. This task does not run
that procedure or claim an operationally deployable saltless-to-new transition.

Acceptance evidence: regressions against the previous source; native immutable
old artifact writes owner/persona/content/media through real HTTP; reopen the
same D1/KV/R2 files using candidate bytes and unchanged synthetic secrets;
verify owner/persona membership, session/data/media/KV continuity and a closed
snapshot restored into a separate disposable directory. A separate old fixture
without salt must show the first-addition re-login requirement honestly, with
unchanged password, owner/personas and content. No identity/session seed SQL,
compatibility lookup, automatic retry, or real-data deletion is permitted.

Public secret custody, sealed materializer update preservation, real OIDC/Takos
login and atomic initial OIDC owner claim remain integration dependencies.
Local native, source/CI and published-environment evidence remain distinct.

The offline native command is `bun run smoke:release-update -- <old-worker>
<candidate-worker>`. It pins the old downloaded bytes and schema before runtime
startup. CI downloads the immutable old Worker through its public release URL
then runs this command after the gate and browser fixture, serially. The
ordinary read-only gate acquires no new network dependency for that download.
No generated old/new Worker is committed. The candidate is an unpublished
commit/digest; package version 2.2.0 does not authorize overwriting that release.

API reference: [Worker Version detail](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
and [secret metadata with value omitted](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/get/).
The latter is explanatory only; the publisher checks its exact active Version
closure and does not add a separate secret-value request.
