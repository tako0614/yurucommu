# Unread counts and notification page lifetime — 2026-10-05

Yurucommu owns the app notification and DM badges. An older poll used to
replace a newer post-read count, and retained counts could cross the same
owner's profile or authentication epoch. Each channel/store now orders reads
by request number, retains only a confirmed count for the captured actor,
auth epoch, hosted identity/instance and resolved SDK transport, and rejects
late success or failure. A newer failed read keeps that scope's confirmed
count while retiring older work. This consumes published Core/API4.1.11;
it does not claim to repair all SDK response/status contracts.

Notification page work captures the actor/auth epoch/instance/strategy and
resolved list/read URLs. Route cleanup and scope retirement prevent old list,
older-page or focus reads from starting a mark-read POST with current-session
credentials. Late mark-read/archive/Follow completions cannot refresh or update
a retired page. Initial read lifetime was already cleanup-fenced; pagination
and focus continuations lacked that boundary. Existing same-owner persona and
external participant distinctions remain unchanged.

Archive and Follow actions also retire earlier list snapshots. Older-page and
focus reads check the list generation before applying rows or marking them
read, and neither read starts while a notification mutation is pending. A new
authentication or transport scope clears retired pending controls so the new
page can operate; completion from the old scope cannot clear new controls.

Acceptance includes deferred badge regressions through the real Jotai atoms,
held built-client browser responses at the actual notification page and nav,
the complete owner gate and exact source/CI qualification. Browser HTTP fixtures
are synthetic, distinct from local workerd-D1 or live qualification. Full logout
redirect/password-login may replace the document, so cross-login page lifetime
must not be claimed from a browser fixture that suppresses that real navigation.
Real issuer custody, operator-data update/recovery, public install topology and
live delivery/native devices remain separate GA dependencies. Publishedv2.3.0
is append-only; these later fixes are excluded.
