# Search Follow state — 2026-10-01

Task GA-20261001-yuru-search-follow, Yurucommu only, after #49. Parent owns
the browser driver, README translations, this ledger and verification. A bounded
worker owns SearchPage.tsx and scripts/release-browser-follow.mjs. No shared
Core/API/schema, other product or original dirty work is modified. No deploy,
real credential/data operation, new authorization or cloud resource is required.

Search previously showed its Follow button again after the published API returned
pending. Store the pending actor IDs for the lifetime of the Search page, display
Requested separately from Following and disable another request. Re-searching
in that page retains the state. Accepted results retain their row and accepted
pill; the following list does not gain duplicate entries.

The browser gate must create two personas through the real account, switch and
profile APIs after the existing empty-DB first owner and feed checks.
Both role=member personas belong to the same human root owner. They are neither
additional human owners nor external participants. Require one live root owner,
exactly these two linked personas, one session and the final active root owner.
No actor/session/follow seed or HTTP success response stub is used.

Use actual Chrome and the built artifact with native D1/KV/R2. A private Follow
must return pending, persist one pending edge without accepted counters and
remain disabled across re-search, with one wire request. Private actors are
excluded from the consumed Core's search, so first discover the public persona,
change that persona to private through the real API before clicking its mounted
result row, then make it public again before re-search. Verify each actual
privacy transition and the still-pending edge; never fake a private search hit.
A public Follow must
return accepted and persist one accepted edge with counters incremented once.
Both states are checked against their actual result rows. The old immutable #49
artifact must fail the pending UI assertion before the new artifact qualifies it.

Published Core/API4.1.11 Actor lookup exposes accepted-only is_following;
followers/following lists filter accepted edges and the typed Actor has no
outgoing pending state. Local state does not qualify page reload, cross-surface
status, remote approval/rejection or cancellation. Another tab changing the
active session is also outside this mounted-page state guarantee. Normal product
profile switching reloads the page and discards the Set. Do not use full account export
or persistent browser guesses as a replacement contract. Propose viewer-scoped
relationship retrieval to the principal/Core owner and require exact published
consumer qualification. This dependency remains open independently of this fix.

The first old-artifact attempt could not find the private fixture in Search and
timed out before a Follow. It is excluded from product regression evidence.
The verifier also replaces its bare username text selector with the scoped
fixture name: real Search usernames include the host. These are fixture/selector
corrections, not product fixes or evidence of a private-profile search leak.

The corrected verifier on immutable #49 artifact
sha256:4fce3b76608adde99334dda1fdd655dd37936e40c77a31e770c3b01d3a735a8e
reaches actual Follow200/pending, one native pending edge/Follow activity/wire
request, zero accepted counters and one owner/two own personas/one session. It
then fails because Requested is missing. Evidence:
operator-runs/yurucommu-ga-search-follow-20261001/browser-old-corrected.log.
Independent source review confirms the privacy transitions, accepted counters,
scoped display-name selectors, immediately observed response waits and final
owner/persona/session guard. Full gate/new artifact/CI remain separate required
qualification steps; do not infer their result from the source review.

Source, mocked plans, native/local browser and CI are distinct from public
self-install, OIDC/concurrent owner claim, actual cross-server transport and
update/restore. Those GA conditions remain open. Serialize the complete read-only
gate behind principal builds, fingerprint tracked and nonignored untracked
source before/after, review the final files and qualify the exact PR head.
