# Yurucommu on Takoform v1

This directory is Yurucommu's portable OpenTofu adapter for the stable
`forms.takoform.com/v1` Host lane. The product-owned logical contract lives in
[`../product-resources.json`](../product-resources.json); the root OpenTofu
module is the separate direct-Cloudflare adapter for the same product roles.

The module targets the independently published Provider `3.0.0` contract
exactly. It does not use the older compatibility resources, Host
materialization output, or a portable object-bucket resource.

## Source preparation

The selected repository revision is the source of truth for both the module
and its Worker bytes. Before OpenTofu evaluates the module, the repository
manifest runs:

```bash
bun run build:worker
bun scripts/prepare-takoform-v1-source.ts
```

The second command hashes the current worktree's
`dist/yurucommu-hosted-worker.js`, copies the exact bytes to
`.generated/yurucommu-worker.js`, verifies the copied digest, and refreshes the
repository-owned `migrations/sql/` files from the digest-verified
`migrations/schema-bundle.json`. A downloaded Worker from an older release is
not evidence for this source revision.

The SQL files are tracked module inputs, so OpenTofu never depends on a Host
copying build output before it can construct `SQLiteMigrationSet`.
`deploy/takoform/.generated/yurucommu-worker.js` remains intentionally
untracked source-build output.

## Provider 3 graph

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
| `EdgeKVNamespace`                | Stores sessions, rate limits, and the observed canonical origin |
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

`DB`, `KV`, and the two queues refer to resources in this graph. `MEDIA` is
different: the Worker version requests exactly one required standard service:

```hcl
external_services = [{
  name     = "MEDIA"
  protocol = "com.amazonaws.s3"
  required = true
}]
```

The Host supplies that opaque standard service as a sealed runtime binding.
No portable desired state, Provider state, or module output contains a bucket
name, endpoint, region, access key, or credential. The hosted artifact accepts
only the sealed service's `fetch` capability and delegates its S3 wire behavior
to Core's provider-neutral `ObjectStore` adapter (`put`, `get`, and `delete`).
The separately built direct-Cloudflare artifact accepts only a native
`R2Bucket` and uses Core's Cloudflare adapter.

## Endpoint and canonical origin

`WorkerEndpoint` is admitted only after `WorkerDeployment` serves a fetch
handler. Its URL is exposed as the ordinary `launch_url` and `api_url` module
outputs; it is never fed back into the immutable `WorkerVersion`.

On its first successful fetch, the runtime validates the request origin and
pins it in `KV` when no operator-supplied `APP_URL` exists. Native queue work
fails closed until a fetch has established that origin. The scheduled
retention path does not invent or consume an application URL.

## Provider 3 validation

The portable repository gate initializes the exact Provider `3.0.0` release
from its public registry source in an isolated temporary directory, then
validates the prepared module:

```bash
bun scripts/validate-takoform-v1.ts
```

To validate an unpublished local Provider 3 candidate instead, provide both
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
the digest-verified source bundle, applies every one of the 13 Provider 3.0.0
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
  and migration digests, the supplied Provider SHA-256, and a Provider 3.0.0
  schema handshake proving every current resource kind was loaded;
- all 13 output UIDs and exact FormRef resource GET readbacks, each with
  `Ready=True` and matching apiVersion/kind/FormRef/name/space/UID/generation;
- `SQLiteMigrationApplication` readiness plus `/nodeinfo/2.0` database-backed
  user/post counters, `/healthz`, `/readyz`, and social-server discovery;
- Host `StandardServiceSupport` for the required `com.amazonaws.s3` service;
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
KV, queue delivery/DLQ behavior, cron dispatch, migrations, or the sealed S3
service. Those phases must remain red until a stable Host both implements the
backends and returns a `WorkerEndpoint.url` that the tracer can request
directly. A schema-valid `.invalid` URL plus an out-of-band loopback rewrite is
diagnostic evidence, not a passing HTTP deployment proof.

## Host responsibilities

The module cannot grant itself cloud authority or synthesize portable storage
credentials. A usable Host must provide:

- the required generated `ENCRYPTION_KEY` and complete OIDC bindings;
- SQLite, migration, KV, queue, consumer, DLQ, and cron implementations;
- a sealed `com.amazonaws.s3` service for `MEDIA`;
- a reachable HTTPS Worker endpoint;
- logs, backup, restore, update, removal, and recovery procedures.

Takoserver's operator-side Cloudflare R2 supply, when enabled by that Host, has
this configuration identity:

```json
{
  "kind": "takoserver.standard-service-supplies@v1",
  "supplies": [
    {
      "serviceRef": {
        "apiVersion": "standards.takoform.com/v1",
        "protocol": "com.amazonaws.s3"
      },
      "backend": { "kind": "cloudflare-r2" }
    }
  ]
}
```

That is Host operator configuration, not Yurucommu module input or output.

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
