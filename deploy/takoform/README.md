# Yurucommu on Takoform v1

This directory is Yurucommu's portable OpenTofu adapter for the stable
`forms.takoform.com/v1` Host lane. The product-owned logical contract lives in
[`../product-resources.json`](../product-resources.json); the root OpenTofu
module is the separate direct-Cloudflare adapter for the same product roles.

The module targets the independent Provider 3 reference implementation. It
does not use the older compatibility resources, Host materialization output,
or a portable object-bucket resource.

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
`.generated/yurucommu-worker.js`, verifies the copied digest, and expands every
digest-verified SQLite migration from `migrations/schema-bundle.json` into
`.generated/migrations/`. A downloaded Worker from an older release is not
evidence for this source revision.

`deploy/takoform/.generated/` is intentionally untracked build output. The
repository metadata declares it as `sourceBuild` output so a Host must prepare
it before evaluation.

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
name, endpoint, region, access key, or credential. The Yurucommu hosted adapter
accepts only object operations (`put`, `get`, `delete`, `list`, and `head`);
the direct-Cloudflare adapter keeps its `R2Bucket` type in a separate file.

## Endpoint and canonical origin

`WorkerEndpoint` is admitted only after `WorkerDeployment` serves a fetch
handler. Its URL is exposed as the ordinary `launch_url` and `api_url` module
outputs; it is never fed back into the immutable `WorkerVersion`.

On its first successful fetch, the runtime validates the request origin and
pins it in `KV` when no operator-supplied `APP_URL` exists. Native queue work
fails closed until a fetch has established that origin. The scheduled
retention path does not invent or consume an application URL.

## Validation with an unpublished Provider 3 candidate

Provider 3 is not assumed to exist in the public registry. Build or otherwise
obtain the exact reviewed provider executable, hash it, and provide both as
explicit local authority:

```bash
export TAKOFORM_PROVIDER_BINARY=/absolute/path/to/terraform-provider-takoform
export TAKOFORM_PROVIDER_SHA256=sha256:<64-lowercase-hex-digest>
bun scripts/validate-takoform-v1.ts
```

The explicit candidate validator verifies the source and copied executable digests, creates a temporary
`TF_CLI_CONFIG_FILE` development override, and validates the prepared module
without pretending that `tofu init` fetched Provider 3. Missing, non-executable,
or mismatched provider bytes fail before validation or mutation. The existing
direct-Cloudflare root module continues to use its checked-in provider lock.

`bun run check:opentofu` remains portable: it checks every committed OpenTofu
module backed by a lockfile, rebuilds the Worker, and verifies source
preparation. It does not silently skip or pretend to validate the unpublished
Provider 3 schema; that cross-repository assertion is the explicit command
above and the TASK-0034 tracer.

## Fetch-only local E2E

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
  scripts/prepare-takoform-v1-source.test.ts \
  scripts/yurucommu-worker-bindings.test.ts
tofu fmt -check -recursive
```

`bun run check` includes the portable graph, runtime, and artifact gates. Exact
Provider 3 validation remains the explicit candidate command above until that
provider has an independently installable release.
