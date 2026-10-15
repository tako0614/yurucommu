# Hosted staging reference-app E2E

One command creates Yurucommu's disposable 15-resource graph through the
current Takoform Host v2 API, checks its public JSON health and database-backed
NodeInfo, deletes the acknowledged graph, and verifies Host and route absence:

```bash
bun --no-env-file tests/e2e-hosted/run.ts --execute
```

Default invocation and `--dry-run` describe phases and missing inputs without
reading operator files, making requests, building, or starting subprocesses.
Use Bun 1.4.0 for the focused checks and execution below. Local test results
establish the harness protocol and failure behavior; they do not establish
an actual staging pass or launch qualification.

## Inputs from the authorized staging owner

All credentials and application private inputs enter through environment
variables. Load them using the operator's existing private mechanism; never
put their values in argv, this repository, shell history, or logs.

| Variable                                 | Input                                                             |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `YURUCOMMU_HOSTED_E2E_ENVIRONMENT`       | `staging`                                                         |
| `YURUCOMMU_HOSTED_E2E_TARGET_FILE`       | Absolute path to nonsecret owner-selected target metadata below   |
| `YURUCOMMU_HOSTED_E2E_FIXTURE_FILE`      | Absolute path to the immutable Yurucommu artifact receipt below   |
| `YURUCOMMU_HOSTED_E2E_JOURNAL_DIRECTORY` | Existing, operator-owned `0700` directory outside this repository |
| `TAKOFORM_TOKEN`                         | Host writer scoped to the target organization/Space               |
| `TAKOFORM_EVIDENCE_TOKEN`                | Distinct Host read credential for the same owner and Space        |
| `ENCRYPTION_KEY`                         | Application-generated 32-byte lowercase hexadecimal value         |
| `YURUCOMMU_SESSION_HASH_SALT`            | Separate, non-development 32-byte lowercase hexadecimal value     |
| `TAKOSUMI_ACCOUNTS_ISSUER_URL`           | Owner-selected HTTPS OIDC issuer                                  |
| `TAKOSUMI_ACCOUNTS_CLIENT_ID`            | Application's provisioned client identity                         |
| `TAKOSUMI_ACCOUNTS_OWNER_SUB`            | Application's provisioned owner subject                           |
| `TAKOSUMI_ACCOUNTS_REDIRECT_URI`         | Application's registered HTTPS callback                           |

Target metadata has the exact fields shown below. Angle brackets are required
owner inputs, so this example is deliberately not runnable:

```json
{
  "kind": "yurucommu.hosted-staging-target@v2",
  "environment": "staging",
  "api": "forms.takoform.com/v2",
  "hostOrigin": "<exact authorized HTTPS staging origin, without trailing slash>",
  "space": "<actual staging organization id>",
  "qualifiedHostCommit": "<40 lowercase hex characters>",
  "qualificationReceiptSha256": "<64 lowercase hex characters>",
  "appSuffix": ".app-staging.takos.jp"
}
```

The Space is the organization id accepted by the current Host credential
flow. The harness generates a fresh `yurucommu-e2e-<12hex>` resource prefix
inside it; it does not invent a disposable Space or mutate the organization.
The hostname must explicitly identify staging, and discovery's advertised v2
base URL must retain that exact origin. The qualification receipt belongs to
the owning operator and must cover the selected commit, API, private-input
custody, SQLite migrations and runtime, Queue/consumer bindings, and wildcard
endpoint dispatch/TLS. The harness records its digest, but cannot create or
independently certify this operator evidence.

The current preparation handoff reports the incumbent Hosted runtime as schema
0088; the new private SQLite candidate requires 0094 plus its 0088 drain seal.
Private SQLite #130 has not been formally transferred to this lane. An old
deployment, prepared `.invalid` fixture, or stale qualification receipt does
not satisfy the execution prerequisites. The latest launch scope retains the
full Container, Actor, Workflow and Tier 1 requirements; this reference-app
health test does not reduce them to an earlier Tier 1-only launch proposal.

## Published artifact receipt

Use the product-owned source build contract in
[.well-known/takosumi.json](../.well-known/takosumi.json),
[scripts/build-yurucommu-worker.ts](../scripts/build-yurucommu-worker.ts), and
[scripts/prepare-takoform-v1-source.ts](../scripts/prepare-takoform-v1-source.ts)
to obtain the real compiled module and ordered migration SQL. That source
preparation script's retained name does not make the resulting module's ABI
v1-only: [scripts/yurucommu-worker-bindings.ts](../scripts/yurucommu-worker-bindings.ts)
uses the portable `edge.sql`, `edge.kv`, `edge.objects` and `edge.queue`
facades from the published Core package. This harness does not build or
publish these artifacts itself.

The owning publisher must attest that the compiled module belongs to the
recorded reviewed source commit and publish both manifests and every referenced
file at immutable, anonymously readable HTTPS URLs. Existing native Worker
inline upload and the private fixed `hello-v1`/`hello-v2` smoke publisher do
not establish arbitrary Yurucommu manifest publication. The generic authorized
publication surface is an unresolved prerequisite in the current handoff.
Do not substitute a new raw-provider publisher or relabel a hello bundle.

The receipt has these exact fields:

```json
{
  "kind": "yurucommu.hosted-artifacts@v2",
  "sourceCommit": "<reviewed 40-character source commit>",
  "productResourcesSha256": "<digest of deploy/product-resources.json bytes>",
  "schemaBundleSha256": "<digest of deploy/takoform/migrations/schema-bundle.json bytes>",
  "workerBundle": {
    "artifact": {
      "url": "<immutable worker manifest URL>",
      "sha256": "<manifest bytes digest>"
    },
    "manifestFile": "<absolute path to those exact manifest bytes>"
  },
  "migrationSet": {
    "artifact": {
      "url": "<immutable migration manifest URL>",
      "sha256": "<manifest bytes digest>"
    },
    "manifestFile": "<absolute path to those exact manifest bytes>"
  }
}
```

Digests are bare lowercase SHA-256 hex. A WorkerBundle manifest contains
`entrypoint: "yurucommu-worker.js"` and one `files` entry with `path`, `url`,
`sha256`, and `mediaType: "application/javascript+module"`. The
SQLiteMigrationSet manifest contains `files` entries with the same four keys,
`mediaType: "application/sql"`, and every migration in the product's checked-in
schema bundle, sorted by name with identical SQL digest. The loader rejects
contract drift, missing migrations, wrong module identity, query/signed URLs,
and changed manifest bytes. Source-to-module provenance is the publisher's
attestation; a filename and hash alone cannot prove how a module was built.
Before the first write, anonymous GETs verify all public bytes against the
receipt. No credential is sent to an artifact URL.

## Current v2 graph and bounded lifecycle

[contracts.ts](../tests/e2e-hosted/contracts.ts) maps the product's actual
[15 resource roles](../deploy/product-resources.json) to 13 exact v2 Form URLs.
The mapped WorkerVersion is `0.5.0`; ModuleWorker and WorkerEndpoint are
`0.3.0`, WorkerDeployment `0.4.0`, QueueConsumer and WorkerCronTrigger
`0.3.0`, and WorkerBundle/SQLiteDatabase/KV/ObjectBucket/Queue Forms `0.2.0`.
SQLiteMigrationSet and SQLiteMigrationApplication use `0.4.0`, following the
merged owning definitions at `takoform-forms` commit
`5842d74942428ba8b35b0b6fd7976291918d21f3`:
[Set](https://github.com/tako0614/takoform-forms/blob/5842d74942428ba8b35b0b6fd7976291918d21f3/spec/forms/SQLiteMigrationSet/0.4.0/index.md)
and
[Application](https://github.com/tako0614/takoform-forms/blob/5842d74942428ba8b35b0b6fd7976291918d21f3/spec/forms/SQLiteMigrationApplication/0.4.0/index.md).
The Application still requires SQLiteDatabase `0.2.0`. These two migration
selectors are source-preparation candidates; they do not claim Host support or
completed artifact, native SQL, or Worker qualification. Exact Host support is
checked before any Resource write. This selector update leaves all 35 checked
SQL files, their schema bundle, the owning artifact emitter, lockfile, and
Worker build inputs unchanged; it does not issue a new build witness.
The other identities retain the public Takoserver source snapshot at `1b44eb09`.
The adapter uses v2 `resourceUid` references, camelCase specifications and
typed binding arrays. It never translates or claims support for the legacy
FormRefs in `deploy/takoform/host-support-profile.json` or Provider `4.1.0`.
The original skeleton at `ef59712` and its typed assertion correction
`6cbd2f9` are retained in history as an unqualified v1 bridge.

The explicit HTTP port uses injected transports for tests, separate writer and
evidence headers, five-second request/body bounds, response-size limits, and
manual redirect handling. It starts with v2 discovery, private-input support,
exact create/read/delete support for all Forms, and exact empty name queries.
It sends the six private inputs only in the WorkerVersion create request.
No subprocess inherits an environment, and no global env, fetch or output
channel is replaced. Proxy and verbose-fetch/debug environment switches are
refused for execution. The CLI emits only a fixed result or fixed failure code.

Each intent is synced to an exclusive `wx`, `0600` `hosted-e2e.jsonl` journal
before sending. There is one run per explicitly supplied directory, so restarting
with a new random resource prefix cannot conceal a previous uncertain run.
The directory is synced, and accepted Operation/resource identities and
generation fences are synced separately. An existing journal prevents any
remote work. Journals contain payload-free public identity/provenance records;
they omit raw responses, specifications, credentials, private inputs and errors.
An accepted Operation is polled read-only for at most 60 seconds, preserving its
id/action/resource/generation. Only `succeeded` with `effect: complete`, exact
Resource readback, current observed generation and `idle` phase advances.
Waiting-input/reconciling, failed/partial effects, timeout, malformed ACK or
changed identity halt the run. A missing HTTP ACK may conceal a committed
effect, so the harness never replays a mutation or automatically destroys after
such a failure. It leaves the journal for owning operator reconciliation;
there is no automatic resume/delete command.

Once every create is settled and owned, the Host-assigned endpoint must be
HTTPS at one valid 3–32-character label under `app-staging.takos.jp`. Its value
comes from Resource output; no hostname is reconstructed from resource names.
`/healthz` and `/readyz` must report service `yurucommu`, status `ok`, and zero
missing bindings. Social-server discovery must use that exact canonical origin;
NodeInfo must report Yurucommu and nonnegative database-backed counters. App
requests carry no cookie or authorization. An HTML 200 is a failure.

A failed health check still proceeds to acknowledged teardown because all
create effects are already settled. Deletes run in reverse graph dependency
order with each resource's expected generation and one fresh idempotency key.
Every delete needs a complete accepted Operation plus authoritative Host
404/410 readback; authorization failure or network loss is not absence. The
former endpoint's `/healthz` must then be 404/410. Any uncertain delete halts
immediately and preserves remaining resources. A health failure remains a
failed result even if teardown succeeds. No outcome rolls back production.

## Focused local checks

```bash
bun --no-env-file tests/e2e-hosted/run.ts --dry-run
bun --no-env-file test tests/e2e-hosted
bunx prettier@3.9.9 --check tests/e2e-hosted docs/e2e-hosted.md
bunx tsc --noEmit --strict --target ESNext --module Preserve \
  --moduleResolution bundler --allowImportingTsExtensions \
  --types bun,node,@cloudflare/workers-types --skipLibCheck tests/e2e-hosted/*.ts
```

Tests contact ephemeral loopback HTTP servers only. They commit real local
resource-map effects and exercise graph creation/readback, bounded accepted
Operation polling, strict health, dependency-ordered teardown and absence.
They also cover lost create/delete ACKs, changed identities, reconciling,
preflight refusal, secret canaries, exclusive journal ownership, manifest/source
drift and the new staging suffix. Synthetic local modules prove protocol
behavior, not execution of the compiled reference app. The repository's
unchanged `bun run check` remains the full portable gate and must be scheduled
separately before final publication.
