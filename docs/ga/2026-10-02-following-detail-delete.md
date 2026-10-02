# Following feed after detail deletion — Yurucommu, 2026-10-02

Separate product unit after qualified #65 (`39ad138`). Yurucommu has one human
owner per personal deployment. Own personas, community roles and external
participants are distinct from that owner. This change adds no owner/identity
model and makes no Yurumeet or shared Core change.

The Following feed includes the owner's own posts and retains its loaded rows
for a fresh route round trip. A successful DELETE from the post detail page
currently removes the target only from the unified feed and staged new posts.
Returning to the fresh Following cache can therefore display a post whose
canonical native object has already been deleted. The normal list action
updates both feeds; the detail action must also remove the exact canonical AP
ID from Following, without discarding unrelated rows or forcing a reload.

Qualification uses the actual public UI seam: owner creates two public Notes,
loads Following from a real native Worker response, opens M1 detail, confirms
its canonical DELETE, and returns to the still-fresh Following view. Native D1
must show M1 absent and M2 present. The same session must return to the selected
Following tab with M2 visible and no replacement Following fetch. Immutable
#65 must display stale M1 at that point; the candidate must omit it. A refused
DELETE must preserve its native object and cached row. No DOM/source-string test
substitutes for this route/cache behavior.

Keep the earlier 100 browser checks in their exact order, append this regression,
run the owning portable gate and exact committed-tree CI, and review source and
evidence independently. Source/local/native/synthetic/CI success is not public
deployment or full GA evidence. Stale in-flight history/replay beyond this
fresh-cache round trip remains separate from this bounded invalidation fix.

Remaining dependencies include all-owner-creation atomicity and non-destructive
existing-state/delete/restore, shared per-intent post/Story/DM replay and Follow
hydration, reference-safe unused uploads, exact app/Provider/Host install and
update/rollback/restore/monitor, real issuer/refresh/materializer/secret custody,
Core error-state/nonce and deployed federation/Queue/Cron.

Protect original dirty install/message-search work, other worktrees and earlier
receipts. No Core/schema change, production deploy/publication, new resources,
billing/auth permission, live D1 apply or real-data deletion. Yurumeet's
ownership premise is unchanged. Serialize local heavy work after a fresh launch
scan; a scan does not reserve the machine.
