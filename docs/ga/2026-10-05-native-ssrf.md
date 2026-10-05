# Native follow SSRF refusal — 2026-10-05

This separate two-peer gate exercises the owning product's authenticated
`POST /api/follow` path with the same freshly built `dist/yurucommu-worker.js`
as the existing Worker, federation and foreign activity ID gates. It uses
published Core/API 4.1.11 without replacing dependencies or network helpers.

A and B each have separate disposable native D1, KV, R2 and queues. Their
owner and session are created through the application API; they represent
different individually deployed single-owner installations. Remote actors
remain remote identities. Actual discovery must identify Yurucommu and each
canonical origin. Exact virtual HTTPS and DoH routes have no public fallback;
unknown outbound is counted and refused. Raw Wrangler bindings, migration
ledger, queue names and normalized runtime compatibility must match the owning
product before its Worker runs.

The fixture warms `/ap/actor` before the baseline readback, because the engine
may legitimately create a separate instance actor before a signed remote GET.
It then drives these uncached target cases through the actual Follow API:

- Loopback IPv4, IPv6 and URL-normalized hexadecimal IPv4 targets must return
  400 `Invalid target_ap_id`, with no DoH or private-target fetch.
- A public-shaped virtual hostname with a public A answer and an IPv4-mapped
  private AAAA answer must return 400 `Failed to fetch remote actor`. Both
  resolver answers are witnessed; actor GET and private-target fetch stay zero.
- A different public-shaped hostname resolves publicly and its actor GET
  returns an actual 302 with a private `Location`. Follow must return the same
  fetch failure; public actor GET is exactly one and private-target fetch zero.

Every refusal compares native DB readbacks for follows, outbound activities,
delivery jobs, actor cache and remote objects, while the original owner/session
remain stable. API error text alone is insufficient: the manifest binds each
response to the resolver/redirect route counters and unchanged data projection.
Unique hostnames avoid cache ambiguity; CNAME replies are immediately empty.

The positive control follows B's actual API-created private actor. Follow must
return 200 with success and pending status, fetch B's real actor through the
virtual router, and create A's remote cache, Follow edge, outbound activity
and actual Queue job. Native delivery must reach B's actual inbox with 202 and
retain its processed activity, claim, inbox projection and pending edge.
Ownership/session readbacks still retain one original local owner per instance.

The explicit `--deny-positive-actor-fetch` control first runs the refusal cases
then returns 502 from the exact B actor GET. Actual Follow must report its
fetch failure and the fixture must fail deliberately, rather than treating
indiscriminate rejection as success. Passing JSON is emitted only after every
assertion, runtime disposal and disposable-state removal. Failure emits FAILED
stderr with a nonzero exit and no passing stdout. The supervisor bounds the
run. Manifests retain safe IDs, hashes, counters and booleans, never private
keys, cookies, raw bodies or signatures.

This gate must qualify its own exact source and built artifact. Its evidence
is disposable local workerd, native Queue and virtual transport for these
finite Follow refusal cases. It does not establish all SSRF/activity types,
public DNS/TLS, live federation, real issuer, existing operator-data update or
restore, another product's behavior, or family GA. Core cannot pin a validated
DNS answer to the outbound connection; its documented low-TTL DNS rebinding
window remains. This gate does not claim to close that window. No Core pin,
schema, owner policy, runtime binding or deployed state changes.
