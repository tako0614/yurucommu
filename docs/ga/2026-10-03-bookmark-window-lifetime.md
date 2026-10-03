# Yurucommu saved-list read window lifetime — 2026-10-03

Product-only unit after PR74/head1eb09ebecd247c9b15802ec16cb143d858f1acd0.
This remains Yurucommu's personal deployment for one human owner; external
participants are not additional deployment owners. No Yurumeet/Core premise,
API/schema/auth policy or other worktree changes.

A saved-list full or older-page GET starts a store-local bookmark read window.
The UI generation fence prevents obsolete publication, but a superseded or
unmounted read leaves the window collecting bookmark ACK metadata until the
network promise settles. The SDK's header timeout is cleared before body
parsing, so a stalled body can retain the window. This is a source-level lifetime
gap, not measured heap growth or a claim that ordinary GETs always stall.

Acceptance: a new full saved-list load retires that component's outstanding
full/pager windows immediately, and page disposal retires its outstanding
windows before network settlement. Late finally cleanup is idempotent and
cannot remove a newer or another component's window. A live current read still
reconciles ACKs, and unrelated Timeline/optimistic mutation windows remain
owned. Test the actual store-local registry with the real SDK deferred fetch
seam while the abandoned promise is still pending, then settle it and verify
that stale content, cursors or errors do not publish.

Scope deliberately stops at saved-list supersession and disposal. A direct
non-null actor A→B switch need not unmount the page; adding one-shot dispose
would leave the page unable to load B. Immediate principal-change retirement
needs a separate page/auth lifecycle design with A→B→A and session-generation
regressions. Request abort needs an SDK signal contract and is outside this
unit. Timeline window lifetime, same-AP-ID identity generation and parallel
successful mutation ordering remain unresolved.

Run focused red/green tests and the complete owner gate after a fresh idle
launch scan, then preserve prior142 browser checks when qualifying the candidate.
Return source/local native/Chrome/CI evidence separately. No merge, publication,
production deploy, live D1 apply, new cloud/billing/auth permissions or real-data
deletion. Real operator update/restore, actual issuer/token custody, published
app/Provider/Host lifecycle, public TLS and live federation/Queue/Cron remain
separate GA dependencies.
