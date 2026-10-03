# Fresh owner artifact verification — 2026-09-30

Task: GA-20260930-yuru-first-owner, Yurucommu only, after #47.
Parent owns scripts/smoke-release-worker.mjs,
scripts/release-worker-smoke.test.ts, docs/product/single-owner.md and this
ledger. A bounded worker owns scripts/release-owner-onboarding.mjs only.
No shared Core/schema/provider, real state/credentials, auth permissions,
Yurumeet product premise or other worktree changes. No publish/deploy.

The existing native artifact journeys seed actors/sessions. Add a separate
disposable runtime store with only the product's authoritative migration bundle
and verify actual browser-cookie and mobile-Bearer password first setup for
PBKDF2 and bootstrap credentials. Confirm rejected initial login has no actor
or session effect, exactly one owner is created with a real persisted salted
session, relogin targets the same owner, and additional profiles remain member
personas of that owner. Exercise owner/persona cookie switching and refusal of
unauthenticated profile creation. No actor/session fixtures may seed this lane.

The actual native password API on workerd is distinct from a deployed native
client, public TLS/browser verification, actual OIDC, concurrent first claims,
external participation and update/restore. Those GA requirements remain open.
No claim that this password evidence closes the shared first-OIDC-claim race.
Use meaningful malformed-artifact regressions and the full read-only owner
gate, with no competing heavy build, followed by exact-head CI and handoff.

Final local `bun run check` completed 2026-09-30 23:59 UTC: 457 portable tests,
0 failures, 26 mocked OpenTofu plans, and all format/lint/type/build gates.
The check preserved source fingerprints and began with no other full check.
Built artifact SHA-256 is
`5c0bb2ee1a02f6056df550ece237c30d412d4fc709f9942ba436612711c46627`.
Its native smoke qualified all four fresh-store cases, each with one owner and
one linked member persona. No compiled artifact or credentials are committed.

Old verifier: six focused cases failed as expected; unrelated filtered tests
are not counted as qualified. Independent review identified missing switch
cookie protection checks and duplicate account IDs. A pre-review-equivalent
helper replay confirmed both defective artifacts were accepted; both regressions
are green with the final verifier, and all eight focused tests pass. The first
cookie mutation selected a deletion cookie and is excluded from that red proof;
the corrected mutation retains the real active credential while dropping its
protection attributes. Both review findings are closed with no remaining major
finding. Exact-head CI and the remaining GA dependencies are recorded in the
integration return; this local evidence does not close those dependencies.
