# Login method recovery — 2026-10-01

Task: `GA-20261001-yuru-auth-method-recovery`, Yurucommu only, after #56.
Parallel family task `GA-20261001-meet-archive-unread` stays in its own assigned
worktree/branch/PR. Parent owns LoginForm, auth-config, tests, translations,
browser driver, ledger and qualification; bounded worker owns only the new OIDC
browser recovery helper. Shared Core/authentication policy, original dirty
trees, control and all other worktrees remain outside the edit scope. No new
credential, permission, billing, resource, deployment or real-data operation.

Source gaps: auth-provider fetch failure invents a password-enabled config;
passwordless OIDC auto-start returns true when sessionStorage is missing or
throws, so a failed round trip can redirect repeatedly. Both are product UI
recovery problems, not permission to change Core owner/session issuance.

First qualify the new real Chrome verifier against immutable #56 Worker bytes.
Require an actual read-failure injection for `/api/auth/providers`, visible
recoverable error and manual retry, no invented password field, and zero
actors/sessions before a successful retry to the real native providers route.
Keep all preceding password/feed/story/profile/follow/DM browser checks.

A separate fresh OIDC-only native Worker and two browser contexts must exercise
actual login redirect and error callback HTTP. Exact synthetic issuer authorize
navigation reaches a real loopback HTTP error server at localhost (distinct
from the app's127.0.0.1 browser site) and returns only `access_denied`; no fake
successful session/token. All other browser origins and all Worker outbound
requests are denied. This does not qualify production HTTPS cookie attributes.
When sessionStorage is unavailable, provider link remains manual and reachable;
after manual failure the generic error and retry remain reachable without an
automatic loop. With storage, auto-start happens once and same-tab reload does
not restart it. Actual Core providers response remains password-disabled, native
actors/sessions remain zero, callback query is removed, and no state/nonce/
cookie/token is printed. This is local browser error-recovery proof, not actual
Takos login, signed-token success, public TLS or atomic first-owner proof.

Fix the UI after actual red evidence. Run explicit fmt, meaningful portable
checks, full read-only `bun run check` on frozen source, fresh local browser and
exact-tree CI; heavy gates serialize after fresh `/proc` inspection and yield to
platform work. Independent auth/UI source and evidence review precedes handoff.
The single-human-owner product premise remains unchanged; communication peers
are not additional human owners. Real OIDC/Takos linkage, public install/
lifecycle/secret custody and principal/Core proposals remain GA dependencies.

Actual controls: immutable #56 Worker provider-read fault renders password input
with no alert/retry; portable storage-denial regression fails on old behavior.
With a real localhost authorization-error server, old Worker browser navigation
at20:18 UTC attempts login/authorize/callback five times. The earlier `.invalid`
issuer attempt did not reach callback and is excluded from loop evidence.
Independent review requires real HTTP server receipt counters and app-bound
callback cookie/state correlation, with bounded excess-request refusal. The
issuer never receives the app's host-only nonce cookie by design.
