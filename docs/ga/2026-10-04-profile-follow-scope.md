# Profile Follow request lifetime — 2026-10-04

A Follow/Unfollow can commit while its response is delayed. Previously its
success, error toast and busy cleanup updated whichever profile was visible
when the response arrived. A→B→A also accepted the first visit's completion.
The busy guard could prevent the new profile's own action.

Capture the target Actor and profile-load generation before issuing the
request. Navigation, Retry and component cleanup retire that generation; only
the current generation/route/Actor may update state, counts, toasts or busy.
Reset busy on every load and expose it on the profile button. Preserve accepted
Follow counts, approval-pending UI and the existing single-owner instance
contract; native local fixtures use the owner's personas rather than additional
human owners. A retired request may still commit on the server.

Acceptance uses held real disposable Worker responses through SPA navigation,
native relationship/counter readback, current-window controls, old-source red
proof, the complete owning gate, real Chrome and exact-source CI. Browser-only
injections are identified separately from native refusals. This is local source
qualification, not a live federation or public/operator-data claim.

Published Core/API4.1.11 still lacks outgoing-pending hydration on Actor lookup.
Reload therefore cannot reconstruct approval-pending status; a duplicate is
refused by the server. Fixing that public contract, publishing it and adopting
it are separate work. Real issuer custody, existing-data update/closed restore,
public install lifecycle and native mobile qualification remain dependencies.
The existing immutable v2.3.0 release is not overwritten by this source change.
