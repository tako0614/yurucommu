# Timeline head polling across view changes — 2026-10-02

Yurucommu-only unit after qualified PR #64 (`b75fbeb`). Parent owns timeline
atoms, portable regressions, browser-driver integration and qualification;
the bounded browser worker owns `scripts/release-browser-timeline-scope.mjs`.
Independent review is read-only. Preserve the original install dirty work,
Yurumeet message-search and every earlier qualification receipt.

The transient community scope is a view filter for the same human owner, not
an ownership or server authorization boundary. Yurucommu remains one human
owner per personal deployment; community roles, personas and remote actors
are distinct. This unit does not define Yurumeet's ownership premise.

The current head poll captures its initial visible feed, fetches asynchronously,
then stages results without checking the current scope or full-load generation.
A held A response can arrive after B has loaded and cleared pending posts,
offer an A new-post pill in B, then prepend A posts to B on click. A -> B -> A
and same-scope reloads also invalidate that old head. Already-staged candidates
survive until the replacement fetch succeeds, including its loading/error state.

Five portable baseline regressions exercise the actual atom/fetch seam and fail
on #64: changed scope, same-scope reload, ABA, scope changed before reload, and
staged candidates during a replacement fetch. The fix fences poll completion
by request community identity and full-load generation, reads live entry
identities when deduplicating, and clears candidates at full-load start. Keep
normal same-scope polls, boost entry identity, watermark and older cursor behavior.

Require actual Chrome with a disposable native Worker and authenticated owner,
real community/filter UI, held old head delivery, B visible feed and normal
same-scope staging/apply. Old-artifact browser failure must reproduce this
specific scope contamination; fixture/setup failures do not count. Record which
API effects are native and which timing or response inputs are synthetic.
The complete owner `bun run check`, browser gate, exact-tree CI and independent
review are required before a verified PR return. Serialize heavy local jobs
after a fresh occupancy scan; that scan does not reserve a slot.

The #64 native artifact reproduced the exact browser defect: real authenticated
owner API writes created A/B communities and posts, an A head GET was held,
B loaded its own response, and release exposed the A pill and A-only row in B.
The fixture's first attempt incorrectly required `community_ap_id` in the
post-create response (the published Core omits it there). That setup failure
is retained and excluded; the corrected fixture verifies the request community
against D1 instead. No Core change was needed. Browser `requestfinished` plus
150ms is practical settling validated by the immutable old-artifact red, not
a formal guarantee of atom continuation; the green lane also consumes and
applies a fresh B poll. Visibility events are dispatched synthetic triggers for
the mounted page's existing poll handler, while payloads and writes are native.

No shared Core/schema changes, production deploy, publication, new resources,
billing/auth permissions, live D1 application, real-data deletion or other
worktree edits. Source/local/native/synthetic/CI evidence does not qualify
published installation, real issuer/token/materializer custody, deployed
federation/Queue/Cron or update/restore/monitoring. Those GA dependencies remain.
