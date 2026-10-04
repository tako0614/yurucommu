# Profile moderation request lifetime

The profile owns page state and notifications for one route/load window. A
block or mute captures its target before sending the request. Navigation,
A→B→A, Retry and component cleanup retire that window. Acknowledged success
still removes the captured author's posts from the shared home, Following and
pending-head caches; it cannot clear another profile's posts, follow state or
emit an obsolete notification. Failed requests do not change shared caches.
Reload also dismisses any pending moderation confirmation.

The disposable native Worker/browser fixture holds an actual successful block
response after its D1 row commits. The unchanged main327eeb96 Worker reproduced
an A success notification on B, with A's follow severed and B's accepted follow
preserved in D1. Early fixture locator failures were not product reproduction.
Candidate acceptance additionally checks cache behavior, route revisits and
separately labeled synthetic refusals. It denies external requests and creates
one password owner plus linked personas through the native account API.

This is a source candidate until complete owner/native/browser checks and PR
CI are qualified. It changes no schema, package dependency, single-owner policy
or release identity. The published v2.3.0 remains immutable and does not include
this later candidate. Real issuer custody, existing operator-data update/restore,
public federation and published app/Provider/Host lifecycle remain separate
evidence. A pre-existing feed read repopulating a moderated author's content is
a separate inferred cache-ordering risk; this slice preserves the acknowledged
shared-cache update and does not claim durable author exclusion across reads.
