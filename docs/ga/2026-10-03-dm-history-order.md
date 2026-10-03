# DM history ordering

The open conversation's first history request can finish after a regular
four-second poll or a successful send. A useful newer poll must display its
messages immediately and retire the older initial success/error. A send
acknowledgement displays its bubble without proving that the complete history
has loaded; a later initial success can add history around that acknowledged
message.

`src/lib/dm-history.ts` owns one panel activation at a time. Each visit has a
distinct token, including A → B → A. Newest reads apply in accepted request
order. An empty or failed poll does not retire a pending initial read. ACKs and
confirmed community deletions fence reads already in flight; a deleted ID stays
excluded for the activation. A fresh read can update a known ACK's payload.

Accumulated pages render in ascending server `(created_at, id)` order. Newest
polls keep loaded older rows at the front. The oldest displayed tuple supplies
the composite cursor. Once older paging starts, newest reads stop setting its
`hasMore`; an older response updates it only when it advances the visible
oldest tuple. Older callbacks, loading finalizers, and deferred scroll work
belong to the same activation. Deferred scroll also checks that its applied
message array still owns the displayed history.

The published API 4.1.11 maps absent DM `messages` to `[]` without checking
HTTP success. The panel cannot distinguish a malformed/error initial response
from true empty history. Empty polls never erase known rows or establish
deletion, and ambiguous empty older pages keep their cursor/button. Fixing the
initial empty/error ambiguity, required response shape, body deadline and caller
abort belongs to the shared API owner.

`src/lib/dm-history.test.ts` uses deferred responses to exercise read order,
ACK payloads, pagination, deletion, activation reentry and scroll ownership.
`scripts/release-browser-dm-history-order.mjs` delays actual disposable Worker
GET bytes and uses public sends in installed Chrome. Its fixture has one human
owner, one linked persona and two independently issued sessions for that owner.
It does not add another owning user or impose this model on Yurumeet/Core.
Canonical browser checks append to the existing ordered suite.

Local native/Chrome checks and CI establish candidate behavior. They do not
prove public TLS, external federation, actual operator data updates/restores,
issuer custody, managed installation or production readiness. Integration
evidence and remaining owner dependencies are recorded separately in Control.
