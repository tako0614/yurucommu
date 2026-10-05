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
controls, transport retry/DLQ/redrive, real issuer integration or existing operator
data update/restore. Core package publication and consumer adoption remain
separate dependencies; this change updates no package version or schema.

## Delayed endpoint recovery

The default smoke now refuses the first genuine signed followers-addressed Create with HTTP 503, before forwarding it to the recipient. It must observe one application job in `retry_wait`, one failed attempt, a closed delivery circuit with one failure, and no recipient Note. The unchanged published Core producer schedules the next native queue wakeup using its real first backoff of about 60 seconds with 20% jitter. The smoke neither changes the clock or ledger nor constructs queue batches.

After the real delay, the same activity, object, recipient and job must deliver with signed inbox HTTP 202. The job retains one failed attempt, clears its error and processing marker, records delivery, and the circuit resets to zero failures. The recipient must contain exactly one Note, with the existing authenticated feed/detail and anonymous denials. Successful delivery does not require clearing `next_attempt_at`; that field is retained by the installed Core success path. The JSON manifest records both scheduled and observed retry delays and `endpointRetryRecovered`. The ledger schedule allows one second of timestamp tolerance around the 48–72 second backoff. Actual arrival is checked separately against that persisted due time: at most two seconds early for timestamp precision and no more than 15 seconds late for local runtime scheduling. Both the success and denial control enforce this bound.

Use `--deny-endpoint-retry` as a strict denial-only control. It refuses the next real retry for that exact activity and object, then requires the same job to remain in `retry_wait` with two failed attempts and no recipient Note. Only after observing that failure does it emit a FAILED record on stderr and exit nonzero, with native runtime/state cleanup. This control cannot be combined with `--deny-peer-key-fetch`; neither control can report a passing journey. The supervisor allows 300 seconds for migration, real delayed delivery, reads and cleanup.

This is an application endpoint-retry regression for the product's built Worker bytes. Native transport retry/DLQ, six-hour reconciliation/redrive, public DNS/TLS and live Queue/Cron/federation remain separate. It does not change published Core pins, schema, account ownership, or deployed state.
