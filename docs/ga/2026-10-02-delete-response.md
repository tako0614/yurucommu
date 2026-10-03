# Delayed feed responses after acknowledged deletion — Yurucommu

This product-local unit follows #66 (`fb73a9b`). A successful detail or list
DELETE removed currently cached rows, but an already-started full/older/head
response could later write the canonical post back into the unified feed,
Following or pending-new-post buffer. A held public-fetch atom regression
reproduced that resurrection before the fix.

Both DELETE callers now await one product-owned action. Only successful public
API acknowledgement records the canonical AP object ID and purges all three
buffers. Every direct or updater write to those buffers filters committed IDs,
including delayed reads, boost entries, pending apply and composer ACKs. Filtering
precedes feed/staging caps; unrelated rows, scroll and raw server cursors/hasMore
remain usable. The unified watermark follows the surviving head. An all-masked
page still exposes manual older-page loading; it does not automatically drain
pages or report an empty feed before the server's remaining pages are exhausted.

The ID set contains no content, media, credential or owner record. It belongs to
one Jotai store and lasts until that store is destroyed, with no TTL/LRU or
persistent storage. Current Core 4.1.11 creates canonical object URIs with random
256-bit IDs. The deletion fact survives scope/persona changes in that store;
reloading the document creates a fresh store and relies on the durable server.
Yurucommu remains one human owner per personal deployment. Own personas,
community roles and external participants are distinct; no ownership premise
is added to Yurumeet and no shared Core contract is changed.

Qualification must hold a real native Worker Following response containing
M1/M2 before deletion, confirm M1's actual UI DELETE and native absence, then
release exactly those bytes. M2 must appear as the continuation canary. Fixed
#66 must resurrect M1; the candidate must suppress it with the same session and
one original request/response. A pre-Worker failed M2 DELETE must retain it.
A separate empty-page fixture narrows the native first request from limit=20
to limit=1, retains the real returned cursor, and uses the UI manual pager for
the next unmodified limit=20 request. Both producer URLs are recorded; this
controlled page-size fixture is separate from the original delayed response.
Keep the existing 105 browser-check prefix, run the portable owner gate and
review exact-tree CI and evidence independently. Source/atom mocks/local native
D1/actual browser/synthetic OIDC/CI are separate from published/live evidence.

Limits: other stores/tabs/devices, persistent suppression across reload, restored
server data, a DELETE committed without a successful ACK, and general cross-auth
response fencing remain unqualified. Shared per-intent replay, owner-claim
atomicity, reference-safe unused uploads, existing-data update/restore, exact
published app/Provider/Host install and rollback/monitor, real issuer/refresh/
secret custody, Core error-state/nonce and deployed federation/Queue/Cron remain
independent GA dependencies. No schema change, live migration, publication,
production deployment, new resource/billing/auth permission or real-data deletion.
