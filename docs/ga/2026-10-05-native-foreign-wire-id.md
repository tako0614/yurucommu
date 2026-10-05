# Native foreign activity ID isolation — 2026-10-05

The existing two-peer gate verifies Follow/Accept, private post/DM delivery,
Digest refusal, signer/actor binding and actual delayed endpoint recovery.
This separate three-peer gate exercises the receiving deduplication boundary
when a valid sender uses another origin's wire activity ID. It runs after the
two-peer gate against the same freshly built `dist/yurucommu-worker.js`.

All three instances use separate disposable native D1, KV, R2 and queues, and
create one owner/session through the application API. Each represents a
different individually deployed single-owner installation. Remote actors stay
remote identities; this test grants no additional local owners or permissions.
Each instance's actual discovery endpoint must identify Yurucommu and its own
canonical origin. Final ownership and session readbacks must retain exactly one
local owner/session per instance, with verified remote senders in receiver cache.
Peer origins and public DNS answers are exact, virtual allowlisted routes;
unknown outbound requests are refused without public network fallback.

C creates a genuine Follow of private B through the actual API and Queue.
Before forwarding it, the fixture sends a separate correctly A-signed Follow
whose claimed actor is A and whose wire ID is that held C request's ID. The
signature uses A's API-created fixture key and fresh Date, Digest and UTF-8
Content-Length. A fixture-only control bridges Node into workerd, where the
exact outgoing Request is reconstructed and verified with A's actual stored
public key before forwarding to B. It verifies body, signed headers, target
and signature without relying on Node-to-worker Host preservation. B must
accept A with 202: a foreign wire ID does not make a legitimate A sender an
actor mismatch.

Before releasing C, the test snapshots A's processed receiver-local activity,
dispatch claim, inbox projection, pending Follow edge and preserved raw
envelope. It then forwards the original C Request with unchanged headers/body.
C must receive 202 and its actual Queue job must reach delivered. B must retain
two separate processed Follow activities, claims, inbox projections and pending
edges; both raw envelopes retain C's wire ID, their verified actors and local
canonical IDs differ, and the prior A snapshot is unchanged.

The original C handler polls a fixture release flag using its own timers for
at most six seconds, within Core's eight-second delivery timeout. A hold
expiry fails with 504; later C Follow requests are refused rather than being
mistaken for the held original. The release control shares no Request or
request-owned Promise between invocations.

Published Core 4.1.11 trusts an activity ID only on the verified actor's own
origin, excluding receiver-local IDs. A's C-origin ID therefore uses a
synthetic identity source derived from A, Follow, B and the exact raw body.
C's original ID uses its trusted wire identity source. Both are scoped by the
normalized verified actor when deriving B's local activity ID. The fixture
computes these expected IDs explicitly without importing Core internals or
writing ledger rows to produce the outcome.

The explicit `--deny-peer-key-fetch` control blocks the receiver's fetch of
C's public key after A has already been processed. It must observe key GET 502
and signed Follow 401, then fail rather than reporting a successful two-sender journey.
The supervisor bounds execution. Passing JSON is emitted only after all
assertions, runtime disposal and temporary-state removal. Failure produces
FAILED stderr and a nonzero exit; it cannot masquerade as passing stdout.
Manifests retain safe IDs, hashes, counts and booleans, never keys, signatures,
raw bodies or cookies.

The owning gate must qualify this product's own current source and built
artifact. This is local workerd, actual native Queue delivery and virtual
transport evidence for Follow isolation only. It does not establish all
activity types, SSRF controls, transport retry/DLQ/redrive, public DNS/TLS,
live federation, real issuer, existing operator-data update/restore, another
product's behavior or family GA. No Core pin, schema, product runtime binding,
owner policy or deployed state changes.
