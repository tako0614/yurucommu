# Bookmarks解除とHome cache — 2026-10-03

Product-only UI unit stacked on PR71/head c7a4f928. Yurucommu is a personal
single-human-owner deployment; communication peers and own personas are not
additional owners. This change does not prescribe Meet/Core ownership.

With the frozen PR71 Worker, actual Chrome created three Notes and saved them.
Bookmarks DELETE200, public list and native actor/object row agreed on one
removal, while both Notes and unrelated saves remained. Returning to Home in
287ms (cache age391ms, no new head request) still showed the removed target as
bookmarked. A fixed nonforwarded503 retained the saved row, error and flag with
one DELETE and no automatic retry. This is disposable native evidence, not an
actual operator-data or public deployment incident.

Acceptance: confirmed Bookmarks removal immediately updates the matching Note
and boost entries in unified Home, Following and the pending head. Preserve
the Note, unrelated saves, order, cursors, freshness timestamps and reading
position. Refusal or lost ACK keeps the prior flag and propagates failure; no
automatic DELETE retry. Observed actor changes/disposal cannot publish late
page state. A same-actor profile refresh still permits confirmation.

The product store action awaits the existing public API void ACK, then updates
the three cached lists. It returns whether the same observed actor can apply
the result; BookmarksPage removes its row only for that result. No backend,
schema, authority or published contract changes are included.

The browser regression uses real password authentication and HTTP composer /
bookmark writes on fresh native D1. Both Home heads must include the target;
both cached tabs must show false after confirmed removal.503 must retain API,
native row, visible saved row and Home state, with explicit visible error and
one request through the SPA round trip. External browser/Worker traffic is
denied. Preserve prior134 ordered checks before the added cache lanes.

This bounded cache transition is not a snapshot/replay protocol. Pre-ACK late
feed/list responses, concurrent later bookmark operations, cross-tab cookie
changes and same-AP-ID logout/login generation remain separate gaps. It does
not certify exactly-once delivery or real issuer/token custody. Actual existing
data update/restore, Yuru-only atomic first-owner/legacy state preservation,
published app+Provider+Host lifecycle, public monitoring and live federation /
Queue/Cron remain separate dependencies. Qualification counts and exact-head
CI are returned in the integration handoff after the final source is tested.
