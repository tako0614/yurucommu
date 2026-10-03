# Confirmed unsave crossing a full head — 2026-10-03

Product-only follow-up to PR72. A deterministic store/public-SDK regression
showed that a full Unified or Following request begun before an unbookmark ACK
could later replace the confirmed false flag with its earlier true snapshot.
Both cases failed before the fix and passed afterwards.

Each active full-head window now records confirmed unsaves for its observed
actor. At commit it corrects only those bookmark fields, including boosts and
objects absent from the displayed feed. The latest displayed flag wins if a
later local interaction changes it. Other server fields, order, cursor and
hasMore remain authoritative. Refusal or lost ACK registers no confirmation.
An observed actor change prevents the earlier full head from publishing.

The confirmation ends with that full request. A subsequent GET can show the
object saved again: reversible bookmark state is not a permanent deletion
tombstone. Creation ACK reconciliation and the existing deletion fence remain
in the same full-head commit boundary.

The native Chrome fixture creates two Notes via the real composer, saves them,
and explicitly retries a fixed nonforwarded initial head503. It holds the
original native GET200 bytes with target saved=true, removes that bookmark
through Bookmarks confirmation, verifies API/native absence, then delivers the
unaltered earlier response. Returning to the same tab must show false with no
new head GET. Unified and Following are separate lanes; a real rebookmark
between them is fixture setup. Owner/session and both Note rows stay unchanged.
This is disposable local evidence, not actual operator data or a public site.

Older-page/poll/list snapshots, concurrent server mutation order, cross-tab or
same-AP-ID session generation and real issuer/token custody remain separate.
Yurucommu stays a personal single-human-owner deployment; this does not assign
the same ownership model to Meet/Core. No API/schema/authority changes, live
D1 apply, deployment or publication. Counts and exact-head CI are returned in
the integration handoff after qualification.
