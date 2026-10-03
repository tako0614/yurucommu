# Single-owner product alignment — 2026-09-30

Task: GA-20260930-yuru-single-owner. Yurucommu only, after root auth-input #46.
Parent owns README.md/README.en.md, site-src/specs/single-user.html,
src/atoms/i18n.ts, src/components/LoginForm.tsx,
src/components/settings/SettingsAccountsSection.tsx, docs/product/single-owner.md,
this ledger and the four prior GA docs (runtime/journeys/auth-lifecycle/post-attachments).
No Yurumeet premise change, shared Core edits, new auth permissions, schema,
real data changes or deploy. Original dirty work and other worktrees protected.

User requirement: personal self-deployment with one human owner; personas and
communication participants must not be presented as additional owning users.
Source audit confirms normal root/subaccount/member/remote boundaries. Clarify
ambiguous product copy and synthetic adversarial fixture scope, and define the
now-explicit single-owner GA requirements. An existing Core first-OIDC-claim
race is proposed to the principal, not silently patched in a product adapter.
Native first setup/concurrency/external participation/lifecycle proof remains
incomplete. Complete owner check, independent review and exact-head CI qualify
only these source corrections; do not claim live ownership conformance.

Validation: final `bun run check` passed on 2026-09-30 (450 portable tests,
0 failures; 26 mocked OpenTofu plans; type, lint, format and portable build).
Source fingerprints were unchanged by the check. Native Worker artifact smoke
passed for SHA-256 `5c0bb2ee1a02f6056df550ece237c30d412d4fc709f9942ba436612711c46627`;
its seeded owner proves neither fresh-owner creation nor concurrent claims.
Independent review found that the public spec's former current-implementation
badge implied guaranteed owner uniqueness. The badge and text now explicitly
mark the Core first-claim gap as unverified; the finding was closed before the
final full check. Exact-head CI is recorded in the integration handoff.
