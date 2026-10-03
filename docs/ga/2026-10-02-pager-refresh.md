# Timeline pager ownership after refresh — Yurucommu, 2026-10-02

Product-only unit after qualified #67 (`d2baa0c`). Preserve original install/TCS
and message-search work, #67 and Yurumeet #41 accepted evidence, and all other
worktrees. Shared Core/API/schema/auth/ownership contracts do not change.
Yurucommu remains one human owner per personal deployment; own personas,
community roles and external participants are separate concepts.

Source gap: unified and Following full loads increment a generation and reset
the cursor, but leave an older pager's busy flag set until its request settles.
A fresh head with a new cursor cannot page while the obsolete GET is held.
Its failure also emits unrelated feedback. Resetting the flag alone would let
the old finalizer clear the next pager's busy state and admit overlapping GETs.

GA condition: each feed in each Jotai store owns its generation and one pager
ticket. A full head replacement invalidates its old ticket immediately, releases
the pager busy state and resets the cursor. An older request may commit rows,
raw next cursor/hasMore or error feedback only while its generation, ticket and
requested cursor still match. Its finalizer may settle only its own ticket.
Current failures retain rows/cursor and one retryable error. Existing deletion
masks, local fields, feed-entry identity and cap semantics remain intact. The
unified head poll uses that same store's generation; Following is independent.
This is request ownership within a feed, not network cancellation, auth epoch,
server snapshot consistency or a new persistent content overlay.

Use deferred public atom/fetch regressions for both completion orders and
success/failure, plus independent-store isolation. Actual Chrome/native-D1
qualification must compare immutable #67 and the candidate using held real
Worker responses and explicit UI actions. Any artificial page sizes, observer
suppression or frontend clock controls must be recorded as fixture boundaries.
Keep prior116 browser checks, complete the read-only owner gate and exact-tree
CI, then independently review and return one qualified PR.

Serialize heavy tests/builds/native/browser after fresh launch scans; a scan is
not a reservation. Do not terminate foreign work. No publication, merge, deploy,
live D1 apply, new billing/auth permissions or real-data deletion. Existing-data
updates, all owner-creation-path atomicity, durable deletion, lost ACK/replay,
real issuer/token custody, managed install and live federation/Queue/Cron remain
separate GA conditions; common-contract changes are proposals to the primary.
