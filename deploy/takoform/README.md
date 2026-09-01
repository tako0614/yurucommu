# Yurucommu on Takoform

`deploy/takoform` is Yurucommu's portable OpenTofu adapter. The product-owned
logical requirements are in [`../product-resources.json`](../product-resources.json);
the root [`../../main.tf`](../../main.tf) is a separate direct-Cloudflare
adapter. This module contains no Cloudflare account identifiers or credentials.

## Provider and resource graph

The module pins the independently published Takoform Provider `3.0.0` from
`registry.terraform.io/tako0614/takoform`. It uses the current `v1beta1`
resource topology:

| Resource                                                                  | Role                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `takoform_module_worker`                                                  | stable Worker identity                                                |
| `takoform_worker_bundle`                                                  | ESM Worker bundle                                                     |
| `takoform_worker_version`                                                 | bundle, bindings, variables, and `fetch`/`queue`/`scheduled` handlers |
| `takoform_worker_deployment`                                              | serves the selected version                                           |
| `takoform_worker_endpoint`                                                | ordinary public endpoint                                              |
| `takoform_sqlite_database`                                                | durable relational store                                              |
| `takoform_sqlite_migration_set` / `takoform_sqlite_migration_application` | ordered schema inputs and convergence                                 |
| `takoform_edge_kv_namespace`                                              | sessions and rate-limit state                                         |
| two `takoform_at_least_once_queue` resources                              | delivery queue and DLQ                                                |
| two `takoform_queue_consumer` resources                                   | main retry/DLQ consumer and terminal DLQ consumer                     |
| `takoform_worker_cron_trigger`                                            | hourly retention invocation                                           |

The Worker version receives these ordinary binding names:

```text
DB  KV  MEDIA  DELIVERY_QUEUE  DELIVERY_DLQ
```

`MEDIA` is one required standard `com.amazonaws.s3` service. The Host supplies
that service as a sealed binding; bucket names, endpoints, regions, keys, and
other credentials are not module inputs or outputs.

## Source and URL inputs

The bundle input is the generated file
`deploy/takoform/.generated/yurucommu-worker.js`. Build it before an apply:

```bash
bun run build:worker
mkdir -p deploy/takoform/.generated
cp dist/yurucommu-worker.js deploy/takoform/.generated/yurucommu-worker.js
```

The generated directory is disposable and must not be committed. Migration SQL
files under `deploy/takoform/migrations/sql/` are tracked module inputs.

`app_url` is a required, plan-known exact HTTPS origin (no path, query,
fragment, userinfo, or trailing slash). It is injected as `APP_URL` so HTTP,
queue, and scheduled invocations share one canonical origin. Queue identities
are derived from `project_name` and are injected as `DELIVERY_QUEUE_NAME` and
`DELIVERY_DLQ_NAME`; both consumers and producers use those same names.

The endpoint URL is exposed through `launch_url` and `api_url` outputs after a
successful deployment. It is ordinary discovery metadata, not an authorization
grant, secret, or input to the immutable Worker version.

## Checks

Run the focused contract checks and provider validation from the repository root:

```bash
tofu -chdir=deploy/takoform init -backend=false -input=false -lockfile=readonly
tofu -chdir=deploy/takoform validate
bun test scripts/takoform-capsule.test.ts \
  scripts/worker-entry-contract.test.ts \
  scripts/runtime-ports.test.ts \
  scripts/built-worker-runtime.test.ts \
  scripts/deploy-preflight.test.ts
```

`bun run check` includes these checks, the direct-Cloudflare adapter, portable
runtime tests, and the built-artifact gate. The built artifact test invokes
`fetch`, `queue`, and `scheduled` paths and exercises the portable DB, KV,
object, and queue producer ports. Portable queue events fail closed when the
Host does not expose settlement operations; native Cloudflare batches retain
their host-backed `ack`/`retry` methods.

## Host responsibilities

The Host must provide the generated sensitive runtime values, SQLite and its
ordered migration application, KV, object storage, queue consumers/DLQ, and the
hourly cron invocation. It must also return a reachable HTTPS endpoint and
provide backup, restore, update, removal, and recovery procedures. A missing
binding or endpoint is an incomplete installation; do not guess a URL from a
resource name.

This module is a resource declaration only. It does not deploy Takoserver,
publish a Worker artifact, or grant Takosumi permissions. Those authorities
remain with their owning systems.
