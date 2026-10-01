# Synthetic OIDC existing-data preservation — 2026-10-01

Task: `GA-20261001-yurucommu-oidc-update-restore`.

Owner: Yurucommu only, after reviewed #55 `f1d5a2f`. Parent owns the native
update runner, CI expectations and this ledger; one bounded worker owns only
`scripts/release-update-oidc.mjs`. No shared Core, Yurumeet, control repository,
original dirty tree or other worktree is changed. No live credential, permission,
billing, resource, deployment, publication or real data mutation is authorized.

Current password update proof does not establish encrypted OIDC token custody.
Extend the existing offline immutable v2.2.0 update command with a fresh pinned
single-owner OIDC lane. A local ES256 issuer implements one-shot authorization
code + PKCE, nonce and JWKS; only its exact synthetic endpoints are admitted by
the Miniflare outbound service. Tokens and keys remain local ephemeral fixtures.
The old immutable Worker must create its actor/session and encrypted access and
refresh token fields through actual HTTP, with no identity/session seed SQL.

Acceptance: unchanged session salt, encryption key and OIDC metadata; actual
native D1/KV/R2 closed/reopen update; byte-exact encrypted fields, unchanged actor,
schema and Note/media; old cookie accepted by candidate; same-subject relogin
rotates cookie and encrypted credentials; native old-code reopen and closed-clone
restore preserve the synthetic identity and encrypted fields. Independent AES-GCM
verification must recover exactly the issuer's access/refresh tokens and reject
wrong-key and modified ciphertext. Credentials and raw response bodies are not
printed. Failure labels remain fixed and safe; all owned runtimes/temp stores
must terminate/clean up before qualification.

The published Core currently stores these provider tokens and checks presence;
it has no decrypt-and-use/refresh path. Primitive verification proves recoverable
ciphertext, not working Takos API access or refresh. Actual OIDC/Takos integration,
public secret custody, sealed materializer preservation and atomic first-owner
claim remain principal/operator dependencies. Do not broaden Yurucommu's
single-owner premise to Yurumeet or infer live GA from synthetic proof.

Required checks: parse-only `node --check`; existing full read-only `bun run check`
on this changed source once; extended immutable-old native update proof; unchanged
Worker bytes may retain #55's browser evidence with its original source identity.
CI must execute the extended native update lane on its own artifact. Heavy local
checks are serial after fresh `/proc` inspection; foreign jobs are never stopped.
Independent review is required for this authentication preservation test change.

The two synthetic OIDC cases distinguish an explicitly configured old salt
(cookie continuity) from old Core's default public fallback (candidate refuses
the old cookie, retains its ciphertext row and requires OIDC re-authentication).
The native old-code rollback keeps the candidate's configured secrets; it does
not undo salt addition or claim that a previous unconfigured secret is restored.
