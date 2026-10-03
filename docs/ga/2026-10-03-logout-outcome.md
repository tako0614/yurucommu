# Yurucommu sign-out recovery — TASK0058

This product unit follows qualified PR70. Its successful revocation and OIDC
auto-start suppression evidence remains separate. The source predicts that a
non-success logout response is accepted, local identity is cleared, and both
callers navigate home, where a still-valid cookie restores authentication and
loses the failure message. Reproduce this on the immutable PR70 Worker before
editing behavior: a fixed browser503 without forwarding, real synthetic OIDC
callback/session, real Settings confirmation, native salted row and old-cookie
readback, observed navigation and no actionable error. Test-only changes do not
change the baseline artifact. Local synthetic failure is not a live incident.

The intended product recovery refuses non-success acknowledgements and uses a
read-only authentication check after the default self-hosted sign-out attempt.
It never automatically repeats POST. An anonymous check permits local sign-out
navigation; a still-observed principal keeps an explicit localized error and
retry in the existing confirmation. An unavailable/malformed check hides stale
identity and shows the authentication error/recheck screen. Only an explicit
user confirmation resends logout. Cancellation is blocked while the operation
is busy. The shared action serializes all callers in the same application store,
and fences old authentication results and superseded logout completion.

Actor-only auth/me cannot identify a HttpOnly session generation. Same actor is
an observed principal, not proof of the same session. Discard the old community
view scope during recovery. A changed principal/strategy must not be overwritten
by an old operation or receive its error/navigation. A fulfilled custom/hosted
plugin logout continues to mean completion under that plugin's existing void
contract; it is not independently qualified revocation. A rejected plugin result
does not infer anonymous from a missing actor, which may represent setup/pending.

Push cleanup precedes logout under the existing contract. A failed sign-out may
therefore leave an authenticated browser without its former push subscription;
this unit does not request permission, create a subscription or qualify real
push recovery. Suppress OIDC auto-start before any asynchronous work and retain
manual sign-in as the escape path.

Core4.1.11 can catch session deletion errors and still return200/clear Cookie.
A browser anonymous observation does not prove the old credential was durably
revoked. Shared producer outcome and session-generation contracts remain owner
proposals. Do not change shared Core/API, auth permissions, schema, salt, tokens,
published bytes or live data here. Personal single-human-owner Yurucommu does
not define Yurumeet's ownership model.

Qualification requires meaningful strategy/action race tests, actual Chrome on
disposable native D1 for503/retry and real committed logout with browser-only
lost ACK, complete owner gate and exact-tree CI, independent review, and all131
prior ordered browser checks. Serialize every test/build/native/browser launch
after a fresh heavy scan. Preserve failed evidence and prior receipts. Source,
mock, native, Chrome, synthetic issuer and CI remain distinct from published or
deployed/live proof; real issuer/custody, existing-data restore, public lifecycle,
initial-owner atomicity and federation/Queue/Cron remain separate GA dependencies.
