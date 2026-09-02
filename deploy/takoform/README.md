# Yurucommu on Takoform v1

This directory is Yurucommu's portable OpenTofu adapter for the stable
`forms.takoform.com/v1` Host lane. The product-owned logical contract lives in
[`../product-resources.json`](../product-resources.json); the root OpenTofu
module is the separate direct-Cloudflare adapter for the same product roles.

The module targets the independently published Provider contract exactly. It
does not use the older compatibility resources or Host materialization output.

### Provider pin

`MEDIA` is a portable `ObjectBucket` Form (`takoform_edge_object_bucket`) bound
through `bucket_bindings`, and neither exists before the publisher-set Provider
`4.0.0` contract. `main.tf` therefore pins that published release exactly:

```hcl
      version = "= 4.0.0"
```

Nothing else in this configuration is specific to that release. The same pin is
declared once more as `TAKOFORM_PROVIDER_VERSION` in
[`../../scripts/takoform-provider-pin.ts`](../../scripts/takoform-provider-pin.ts),
so moving it stays a two-line change rather than a literal every gate has to
find again.

The root direct-Cloudflare module keeps its own checked-in
`.terraform.lock.hcl`; this module has none, because `validate-takoform-v1.ts`
initializes the pinned Provider fresh in an isolated temporary directory each
run. An unpublished local candidate can be validated instead through
`TAKOFORM_PROVIDER_BINARY` / `TAKOFORM_PROVIDER_SHA256` (below).

## Runtime lane

The Worker bundle runs on two binding shapes, and `runtime_lane` declares which
one this deployment's Host will project. It becomes the Worker's
`YURUCOMMU_RUNTIME_LANE` plain variable.

| `runtime_lane`         | Host                                                                      | `DB`         | `KV`           | `MEDIA`        | queues       |
| ---------------------- | ------------------------------------------------------------------------- | ------------ | -------------- | -------------- | ------------ |
| `cloudflare` (default) | production Takoserver (ordinary Workers), and a plain `wrangler deploy`    | `D1Database` | KV namespace   | `R2Bucket`     | `Queue`      |
| `portable`             | a wrapper host: a self-hosted Takoserver, or a managed Takoserver backend  | `edge.sql`   | `edge.kv`      | `edge.objects` | `edge.queue` |

**Production Takoserver and plain Cloudflare leave it at the default.** A
self-hosted or managed Takoserver sets it:

```bash
tofu apply -var runtime_lane=portable
```

The lane names the BINDING SHAPE, not the tool that published the Worker, so it
cannot be inferred from the fact that this is a Takoform module — the same
configuration lands on either kind of Host. It is declared rather than sniffed
because two bindings are indistinguishable by shape: `edge.kv` and a KV
namespace expose the same five methods, and both queue producers are
`send`/`sendBatch`. The Worker cross-checks the declaration against the bindings
that are decisive (`DB` always, `MEDIA` when bound) and refuses to start on a
disagreement, instead of handing a facade to a D1 client and failing later as a
corrupt session. The retired value `takoform-v1` is not a lane and is refused
the same way.

The lane also decides where this instance's public origin comes from, which is
the one difference that changes what an operator has to supply: see
[Endpoint and public origin](#endpoint-and-public-origin).

## Source preparation

The selected repository revision is the source of truth for both the module
and its Worker bytes. Before OpenTofu evaluates the module, the repository
manifest runs:

```bash
bun run build:worker
bun scripts/prepare-takoform-v1-source.ts
```

The second command hashes the current worktree's
`dist/yurucommu-worker.js`, copies the exact bytes to
`.generated/yurucommu-worker.js`, verifies the copied digest, and refreshes the
repository-owned `migrations/sql/` files from the digest-verified
`migrations/schema-bundle.json`. A downloaded Worker from an older release is
not evidence for this source revision.

The SQL files are tracked module inputs, so OpenTofu never depends on a Host
copying build output before it can construct `SQLiteMigrationSet`.
`deploy/takoform/.generated/yurucommu-worker.js` remains intentionally
untracked source-build output.

## Provider 4 graph

| Provider resource                | Product role                                                    |
| -------------------------------- | --------------------------------------------------------------- |
| `ModuleWorker`                   | Stable Worker identity                                          |
| `WorkerBundle`                   | Current, digest-verified ESM bundle                             |
| `WorkerVersion`                  | Immutable bundle, bindings, variables, and native handlers      |
| `WorkerDeployment`               | Routes 100% of traffic to the prepared version                  |
| `WorkerEndpoint`                 | Allocates the ordinary public Worker URL after deployment       |
| `SQLiteDatabase`                 | Stores Yurucommu durable relational data                        |
| `SQLiteMigrationSet`             | Carries the exact ordered SQL files                             |
| `SQLiteMigrationApplication`     | Converges the migration set before the Worker version           |
| `EdgeKVNamespace`                | Stores sessions, rate limits, and the observed public origin    |
| `ObjectBucket`                   | Stores uploaded media objects                                   |
| two `AtLeastOnceQueue` resources | Delivery work and its dead-letter queue                         |
| `QueueConsumer`                  | Delivers native queue batches and applies retry/DLQ policy      |
| `WorkerCronTrigger`              | Invokes the native scheduled handler hourly                     |

The Worker version exports the native `fetch`, `queue`, and `scheduled`
handlers. Queue and cron events are not translated through a Host-authenticated
HTTP wrapper.

Runtime bindings are:

```text
DB
KV
DELIVERY_QUEUE
DELIVERY_DLQ
MEDIA
```

Every one of them refers to a resource in this graph, `MEDIA` included: it is a
portable `ObjectBucket` the module owns, bound as an ordinary
`bucket_bindings` entry. It used to be a required `com.amazonaws.s3`
`external_services` entry, which asked every Host for a standard service no
Host is obliged to supply; the Form asks for storage the graph itself creates.

No portable desired state, Provider state, or module output contains a bucket
name, endpoint, region, access key, or credential. The Worker reaches the
bucket through the core's provider-neutral `ObjectStore` port (`put` / `get` /
`delete` only) — materialized from a native `R2Bucket` on the `cloudflare` lane
and from the `edge.objects` facade on the `portable` one.

## Endpoint and public origin

`WorkerEndpoint` is admitted only after `WorkerDeployment` serves a fetch
handler. Its URL is exposed as the ordinary `launch_url` and `api_url` module
outputs; it is never fed back into the immutable `WorkerVersion`. That ordering
is why `APP_URL` cannot simply be passed here: the origin does not exist yet
when the version that would carry it is sealed, and there is no second apply
that could inject it afterwards.

**On `runtime_lane = portable`, leave `APP_URL` unset.** The Worker establishes
its public origin from the first https request the Host routes to it and pins
that value in `KV`, and every later request and every queue batch reads the pin.
First writer wins: once a value is stored no later request replaces it, whatever
`Host` header that request carried. The rule lives in
`@takosjp/yurucommu-core` (`>= 4.1.2`, `src/backend/runtime/public-origin.ts`),
not in this module and not in the product's Worker entry, because every actor
id, delivery signature, and `.well-known` document is built from the same value.

Only the request URL as the runtime delivers it is trusted — never
`X-Forwarded-Host`, `X-Forwarded-Proto`, or a `Host` header. It must be https,
with loopback http the single exception. **A self-host that terminates TLS in
front of the Worker and speaks plain http to it therefore establishes nothing
and must set `APP_URL`**, which it can: an operator who terminates TLS chose the
hostname themselves. Refusing is the point; the alternative is trusting a
forwarded-proto header that same proxy may not be the only writer of.

**On `runtime_lane = cloudflare` nothing is inferred.** A Worker with raw
Cloudflare bindings answers on workers.dev and on every custom domain and route
pattern its account holds, so the first hostname to arrive must not be allowed
to name the instance permanently. That lane requires an explicit `APP_URL`, and
`/readyz` reports it as a missing binding until it has one.

### The rule for `APP_URL` in this module

Neither `vars_json` nor the repository manifest declares `APP_URL` for the
Takoform lane, and both stay that way. `local.worker_plain_values` carries
`YURUCOMMU_RUNTIME_LANE` alone, so the `WorkerVersion` contains no origin at
all — which is what lets the same immutable version serve whatever endpoint the
Host later allocates. A Takoform install that needs the runtime to name itself
therefore runs `runtime_lane = portable`.

The consequence for the other lane is worth stating plainly: because this module
passes no `APP_URL` and the `cloudflare` lane infers none, a `cloudflare`-lane
Takoform install is not ready until its Host supplies the origin some other way.
Choosing `portable` is the supported answer whenever the Host, not the deployer,
picks the endpoint.

Native queue work fails closed with `PublicOriginError` until an origin exists,
so delivery is retried after traffic has established one instead of addressed
from `undefined/ap/users/...`. The scheduled retention path neither invents nor
consumes an application URL.

## Provider validation

The portable repository gate initializes the exact Provider `4.0.0` release
from its public registry source in an isolated temporary directory, then
validates the prepared module:

```bash
bun scripts/validate-takoform-v1.ts
```

To validate an unpublished local Provider candidate instead, provide both
the exact executable and its digest as explicit authority:

```bash
export TAKOFORM_PROVIDER_BINARY=/absolute/path/to/terraform-provider-takoform
export TAKOFORM_PROVIDER_SHA256=sha256:<64-lowercase-hex-digest>
bun scripts/validate-takoform-v1.ts
```

The candidate path verifies the source and copied executable digests, creates a
temporary `TF_CLI_CONFIG_FILE` development override, and validates the prepared
module without pretending that `tofu init` fetched those local bytes. A partial
configuration, non-executable file, or digest mismatch fails before validation
or mutation. The existing direct-Cloudflare root module continues to use its
checked-in provider lock.

Registry validation writes an explicit temporary CLI config containing only a
`direct {}` installation method. It does not inherit `TF_CLI_CONFIG_FILE`,
the legacy `TERRAFORM_CONFIG`, `HOME/.tofurc`, or XDG development overrides.
Both registry and local-candidate validation remove inherited `TF_CLI_ARGS` and
every `TF_CLI_ARGS_*` variable before spawning OpenTofu, so a caller cannot
inject `-plugin-dir` or other CLI arguments around the owned installation path.
They also discard inherited plugin-cache, reattach, and plugin TLS/handshake
authority, and replace `TF_DATA_DIR` with a path inside the temporary copy;
ordinary logging, proxy, and registry retry configuration remains available.
`bun run check:opentofu` checks the direct-Cloudflare module against its
committed lock, rebuilds the Worker, and verifies source preparation. The
Takoform module is copied to a temporary directory where its exact Provider
constraint is initialized and validated; the ephemeral lock, CLI config, data
directory, and plugin files are removed with that copy and never written into
the selected source directory.

## Full current lifecycle E2E

The current graph has a checked-in lifecycle runner for a caller-supplied
stable Host. It copies this module after rebuilding the Worker and preparing
the digest-verified source bundle, applies every one of the 14 Provider 4.0.0
resources, reads the exact Host representations back, probes the assigned
Yurucommu runtime, destroys the graph, and verifies that every exact resource
reference is absent.

```bash
TAKOFORM_ENDPOINT=https://forms.example.test \
TAKOFORM_SPACE=disposable-space \
TAKOFORM_TOKEN=... \
TAKOFORM_EVIDENCE_TOKEN=... \
TAKOFORM_PROVIDER_BINARY=/absolute/path/to/terraform-provider-takoform \
TAKOFORM_PROVIDER_SHA256=sha256:<64-lowercase-hex-digest> \
bun run e2e:takoform-v1:full
```

`TAKOFORM_ENDPOINT` is a bare origin. Discovery negotiates the stable
`/.well-known/takoform/v1` document and rejects a cross-origin or alternate API
path before resource readback. `TAKOFORM_TOKEN` is supplied only to the
Provider child for mutations; `TAKOFORM_EVIDENCE_TOKEN` is supplied only to
direct Host discovery/readback/absence evidence. Keep them as separate
credentials. Neither token nor any Worker runtime secret is synthesized or
printed by the runner.
Every Bun/OpenTofu/Git child has a hard timeout. The default is 20 minutes per
child; set `TAKOFORM_E2E_TIMEOUT_SECONDS` (1--86400 integer seconds) when a
Host needs a different bound. A timeout sends TERM, escalates to KILL after a
short grace period, and still enters destroy/absence recovery if apply had
started. On POSIX, each child owns a detached process group so descendants
holding inherited output pipes are terminated without signalling the caller's
group. SIGINT/SIGTERM requests the same cleanup path.
The local Provider executable is copied only after its digest is verified, and
the runner uses a temporary OpenTofu state and CLI configuration.

The passing report includes:

- a run-bound provenance record containing the exact source HEAD and a digest
  of dirty/untracked state, the copied module file inventory, generated Worker
  and migration digests, the supplied Provider SHA-256, and a Provider schema
  handshake at the pinned version proving every current resource kind was
  loaded;
- all 14 output UIDs and exact FormRef resource GET readbacks, each with
  `Ready=True` and matching apiVersion/kind/FormRef/name/space/UID/generation;
- `SQLiteMigrationApplication` readiness plus `/nodeinfo/2.0` database-backed
  user/post counters, `/healthz`, `/readyz`, and social-server discovery;
- `ObjectBucket` readiness for `MEDIA`, which is a Form in this graph rather
  than a standard service the Host has to be able to supply;
- `QueueConsumer` and `WorkerCronTrigger` readiness from Host status; stable
  Host API v1 has no portable queue/cron invocation-counter surface, so the
  report explicitly records invocation counters as unavailable rather than
  claiming event execution; and
- a destroy followed by an exact FormRef GET for each resource, requiring the
  Host's `resource_not_found` error envelope. Failed cleanup preserves the
  temporary state path for recovery.

`TAKOFORM_DIAGNOSTIC_RUNTIME_ENDPOINT=http://127.0.0.1:...` is an optional
test-only loopback runtime target for a Host that intentionally returns a
non-routable assigned URL. The report marks this as diagnostic evidence and it
does not turn the assigned URL into a passing HTTP deployment proof.

The full runner is deliberately not executed by repository checks: it mutates
the caller's Host and requires operator credentials. Run it only with a
disposable space and an explicit Provider binary/digest.

## Fetch-only local tracer

The first stable-v1 E2E slice deliberately provisions only
`ModuleWorker -> WorkerBundle -> WorkerVersion(fetch) -> WorkerDeployment ->
WorkerEndpoint`. It then sends an actual GET to the exact
`WorkerEndpoint.url`, verifies a per-run nonce, and destroys the resources.

```bash
TAKOFORM_ENDPOINT=https://forms.example.test/v1 \
TAKOFORM_SPACE=disposable-space \
TAKOFORM_TOKEN=... \
TAKOFORM_PROVIDER_BINARY=/absolute/path/to/terraform-provider-takoform \
TAKOFORM_PROVIDER_SHA256=sha256:<64-lowercase-hex-digest> \
bun run e2e:takoform-v1
```

This retained tracer is useful for a small Host smoke check; the full current
graph and lifecycle proof use `bun run e2e:takoform-v1:full` above.

Loopback HTTP is accepted for a disposable local Host; non-loopback Host
endpoints must use HTTPS. The tracer does not run a registry `init`, never
places the token in CLI arguments or its generated provider configuration, and
preserves the temporary state path if cleanup fails.

This tracer reports only `phase: "fetch-only"`. It is not evidence for SQLite,
KV, object-bucket, queue delivery/DLQ behavior, cron dispatch, or migrations. Those phases must remain red until a stable Host both implements the
backends and returns a `WorkerEndpoint.url` that the tracer can request
directly. A schema-valid `.invalid` URL plus an out-of-band loopback rewrite is
diagnostic evidence, not a passing HTTP deployment proof.

## Host responsibilities

The module cannot grant itself cloud authority or synthesize portable storage
credentials. A usable Host must provide:

- the required generated `ENCRYPTION_KEY` and complete OIDC bindings;
- SQLite, migration, KV, object-bucket, queue, consumer, DLQ, and cron
  implementations;
- a reachable HTTPS Worker endpoint;
- logs, backup, restore, update, removal, and recovery procedures.

How a Host backs the `ObjectBucket` — R2 on a Cloudflare-backed Takoserver, or
anything else — is that Host's operator configuration, not Yurucommu module
input or output. It reaches the Worker as a native `R2Bucket` on the
`cloudflare` lane and as the `edge.objects` facade on the `portable` one.

## Focused checks

```bash
bun test scripts/takoform-capsule.test.ts \
  scripts/takoform-v1-e2e.test.ts \
  scripts/takoform-v1-e2e-full.test.ts \
  scripts/validate-takoform-v1.test.ts \
  scripts/prepare-takoform-v1-source.test.ts \
  scripts/yurucommu-worker-bindings.test.ts
tofu fmt -check -recursive
```

`bun run check` includes both OpenTofu modules, the portable graph, runtime, and
artifact gates. The local-candidate environment variables remain an explicit
override for testing bytes that are not available from the registry.
