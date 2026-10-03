# Yurucommu feed read window lifetime — 2026-10-03

Product-local unit after PR75. Yurucommu remains software each human owner
deploys for personal use. A community scope or that owner's persona is not a
second deployment owner. This premise is not extended to Yurumeet or Core.

A full Home reload invalidates its earlier full, pager and head-poll GETs.
Generation fences reject their late results, but their bookmark reconciliation
windows can keep collecting ACK metadata until the SDK request settles. A
stalled response body can outlive the SDK header timeout. This is a source and
store-registry lifetime issue, not measured heap growth.

Acceptance: each feed owns the bookmark windows of its GETs in this Jotai
store. A unified full reload immediately retires all prior unified full, pager
and poll windows. A Following full reload retires only its own full and pager
windows. Late finalizers remove only their exact tickets and preserve newer
requests, other feeds, saved-list reads and optimistic mutation windows.
Current reads retain ACK reconciliation. Existing generation, scope, actor,
head and pager publication guards, server cursors and cache reuse remain.

Test the actual shared registry through the real SDK deferred-fetch seam while
old requests remain unresolved. Cover old success/failure/finalizers, both
feeds' pagers, multiple unified polls, feed isolation, unrelated saved-list and
mutation ownership, and later ACK preservation. Settle fixture requests in
cleanup so the SDK timers do not survive the tests. Preserve the existing 142
ordered native Chrome checks when qualifying the candidate.

This unit retires requests on full reload. Route unmount deliberately retains
the shared feed for reading-position and 60-second cache reuse; a hung request
without a later reload can still retain its window. Same-generation polls may
still overlap. Request cancellation, direct non-null actor transitions,
durable session generation and concurrent successful mutation order are
separate contracts. No Core/API/schema/auth policy or other-worktree change.

Run focused red/green and the complete owner gate after fresh idle launch
scans. Distinguish source, local native, Chrome and CI from live evidence.
Operator existing-data update/restore, real issuer/token custody, published
app/Provider/Host lifecycle, public TLS and live federation/Queue/Cron remain
GA dependencies. No merge, publication, production deploy, live D1 apply,
new cloud/billing/auth permissions or real-data deletion.
