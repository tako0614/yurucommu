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
| `WorkerCustomDomain`             | Attaches the plan-known canonical HTTPS hostname                |
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

## Custom domain and canonical origin

The required `app_url` is a canonical lowercase HTTPS origin known at Plan.
`WorkerCustomDomain` attaches that exact hostname after `WorkerDeployment`
serves a fetch handler. The same value is projected to `APP_URL` and exposed as
the ordinary `launch_url` and `api_url` module outputs; no computed Host address
is fed back into the immutable `WorkerVersion`.

The manifest's `http.endpoint` and `identity.oidc` requirements share this
plan-known origin. OIDC delivery is accepted only as the exact Accounts URL,
issuer URL, client ID, and redirect URI quartet, and the redirect URI must equal
`<app_url>/api/auth/callback/takos`. Native queue work therefore receives the
same `APP_URL`; the scheduled retention path does not invent an origin.

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
backends and serves the requested address directly. The fetch-only provider
tracer intentionally continues testing the separate host-assigned
`WorkerEndpoint` Form. A schema-valid `.invalid` URL plus an out-of-band loopback rewrite is
diagnostic evidence, not a passing HTTP deployment proof.

## Host responsibilities

The module cannot grant itself cloud authority or synthesize portable storage
credentials. A usable Host must provide:

- the required generated `ENCRYPTION_KEY` and the generic capability values
  declared by the repository manifest;
- SQLite, migration, KV, queue, consumer, DLQ, and cron implementations;
- a sealed `com.amazonaws.s3` service for `MEDIA`;
- the requested reachable HTTPS custom domain;
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
  scripts/validate-takoform-v1.test.ts \
  scripts/prepare-takoform-v1-source.test.ts \
  scripts/yurucommu-worker-bindings.test.ts
tofu fmt -check -recursive
```

`bun run check` includes both OpenTofu modules, the portable graph, runtime, and
artifact gates. The local-candidate environment variables remain an explicit
override for testing bytes that are not available from the registry.
