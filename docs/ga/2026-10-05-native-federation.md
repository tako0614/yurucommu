# Native two-instance federation coverage — 2026-10-05

The existing artifact smoke qualifies one native Worker and its local journeys.
It does not cover independent owners communicating through the actual signed
ActivityPub and queue pipeline. The new release-federation smoke runs two
instances of the same freshly built Yurucommu artifact, each with its own
disposable D1, KV, R2 and delivery queues. `bun run check` runs it after the
existing artifact smoke, reusing the built bytes.

Both owners and sessions come from the password login API. A requests to follow
private B, B sees the pending request and accepts, and both relationship APIs
and databases must agree. B then sends a followers-only post and a direct
message to A. The sender's attributed delivery job, recipient data and
authenticated reads must agree; anonymous reads must be denied. Remote actors
remain cached remote identities without becoming local owners or sessions.
This preserves Yurucommu's individually deployed single-owner premise.

The recipient's activity ID is receiver-local and derived from the verified
sender actor plus original wire ID. The stored raw envelope keeps that wire ID.
Conversation IDs also use the local origin; each API is compared to its own
database rather than requiring cross-host conversation IDs to match.

The transport fixture virtualizes DNS and exact declared peer HTTPS origins
inside one native workerd. It preserves the product-generated URL, Host, body,
digest and signature and has no external network fallback. The supervisor
bounds the process group; a passing manifest requires runtime disposal and
temporary state cleanup. The explicit `--deny-peer-key-fetch` fixture denies
unsigned signer-key requests to demonstrate that missing delivery fails the
journey. It must fail, with no passing manifest, and grants no bypass.

Prior cross-product qualification using separately qualified Yurucommu and
Yurumeet artifacts passed Follow/Accept and B-to-A post/DM. That proof remains
separate from this same-product regression gate. This source unit's own gate,
denial control and CI must qualify its own scripts and freshly rebuilt bytes;
the earlier cross-product artifact run cannot substitute for them.

Neither fixture proves public DNS/TLS, live federation, signature/SSRF negative
controls, failure retry/redrive, real issuer integration or existing operator
data update/restore. Core package publication and consumer adoption remain
separate dependencies; this change updates no package version or schema.
