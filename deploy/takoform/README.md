# Managed Yurucommu deployment

This directory describes the resources Yurucommu needs when it is installed on
Takosumi or another compatible host.

It uses Takoform, an OpenTofu provider whose resource types describe portable
services such as an edge application, a SQL database, and an object bucket. The host
decides how to implement those services. The definition does not contain
Cloudflare account IDs, credentials, or Cloudflare-specific resource types.

For the end-to-end installation steps, start with
[the main README](../../README.en.md#install-on-takosumi).

## Source to select

Use the Yurucommu repository with:

| Field | Value                                   |
| ----- | --------------------------------------- |
| path  | `deploy/takoform`                       |
| ref   | a stable release tag or reviewed commit |

The selected source also contains
[`/.well-known/takosumi.json`](../../.well-known/takosumi.json). Takosumi reads
the `deploy/takoform` entry from that file to label the installation screen.
The only service-specific value is the service name; the pinned release values
come from this module's defaults. Provider credentials and secret values do not
come from repository metadata.

## Resources created

| Resource              | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `EdgeWorker`          | Runs the Yurucommu web app and API                                       |
| `RelationalDatabase`  | Stores accounts, posts, follows, messages, and notifications in SQLite   |
| `ObjectBucket`        | Stores uploaded images and video                                         |
| `KeyValueStore`       | Stores sessions, sign-in attempt limits, and rate limits                 |
| two `Queue` resources | Handles delivery retries and keeps exhausted work in a dead-letter queue |
| `Schedule`            | Invokes the retention task daily at 03:00 UTC                            |
| `http.request@1`      | Lets OpenTofu read the host-resolved HTTPS endpoint                      |

The HTTP service connects to the other resources through the names expected by
the Yurucommu runtime:

```text
DB
MEDIA
KV
DELIVERY_QUEUE
DELIVERY_DLQ
```

These are connection names, not Cloudflare bindings. A compatible host maps
them to its own database, storage, and queue implementations.

## Release and database migration

The module pins three values together:

- the Yurucommu release tag;
- the immutable Worker download URL; and
- the Worker's SHA-256 digest.

An update must change all three to the same release. This prevents an
installation from downloading different bytes under an unchanged definition.

[`migrations/schema-bundle.json`](migrations/schema-bundle.json) is one
self-contained immutable database artifact. It is generated from the exact
installed and locked `@takosjp/yurucommu-core` migration files, with each SQL
body and its SHA-256 digest inline. The database resource declares this bundle;
the selected host verifies and converges it during that resource's Apply, before
the resource can become Ready. Ordinary OpenTofu outputs are not used as
permission to run SQL.

## How the app URL is discovered

The `EdgeWorker` Form declares `http.request@1`. After the Resource is Ready,
the host resolves that Interface to a credential-free HTTPS `resource_uri`.
The module reads it through the read-only `takoform_interface` data source and
exposes:

- `launch_url` for the web app;
- `api_url` for the `/api` endpoint.

`resource_uri` is runtime discovery metadata, not a Resource output, credential,
or authorization grant. The reviewed v2 `interfaces` declaration in the repository
manifest compiles to a Capsule-owned `interface.ui.surface@1` Interface. Its
`inputs.url` explicitly maps to the ordinary `launch_url` module output; an output
alone does not materialize the Apps-screen surface. Takosumi grants the installer
permission through the declared binding request separately. The dashboard never
guesses a URL from a Worker name or cloud resource ID.

## What remains the host's responsibility

This module describes the resource graph, but it cannot grant itself access to
a cloud account or decide host policy. Before the installation is usable, the
host must provide:

- a public HTTPS URL for the HTTP service;
- an `ENCRYPTION_KEY` secret;
- password authentication or a complete OIDC setup;
- working database, media, key-value, and queue connections;
- queue consumers, dead-letter handling, and the daily scheduled invocation;
- execution of the pinned database migration;
- authorization for the person allowed to open the Yurucommu UI surface;
- logs, backup, restore, update, and removal procedures.

Browser Web Push is optional and is not stored in this module's state. A host
that offers it must inject the gateway URL and public VAPID key as runtime
configuration, plus a token when its gateway requires one.

The root [`main.tf`](../../main.tf) and
[`wrangler.jsonc`](../../wrangler.jsonc) are a separate Cloudflare self-hosting
path. This module does not import them and does not send this resource graph
through a Cloudflare compatibility API.

## Check before publishing

From the repository root:

```bash
tofu -chdir=deploy/takoform init -backend=false -input=false -lockfile=readonly
tofu -chdir=deploy/takoform validate
bun test scripts/takoform-capsule.test.ts scripts/takosumi-install-ux.test.ts
```

`bun run check` runs these checks as part of the repository's full gate.

## Troubleshooting

### The Apps screen has no Yurucommu link

Check, in this order:

1. Apply completed successfully.
2. `EdgeWorker` is Ready with exact canonical native-resource evidence.
3. `http.request@1` returns a non-secret `resource_uri`.
4. `launch_url` resolved and the current principal has `ui.open` permission.

Do not build a fallback URL from a provider ID. A missing launcher is an
incomplete installation, not a naming problem.

### The service starts but `/healthz` lists missing bindings

Compare the five connection names above with the host's realized connections.
Then verify that the queue and schedule activations target the same HTTP
service revision.

### Apply succeeds but the schema is missing

Check that `takoform_relational_database.database` declares the exact immutable
`migrations/schema-bundle.json` URL and digest, and that the host recorded a
successful migration before reporting that database Ready. Do not choose a
database by a similar name and run SQL against it.

### A release update is rejected

Confirm that the release tag, artifact URL, and SHA-256 all refer to the same
published Yurucommu release. Also confirm that the source ref includes the
matching schema bundle.
