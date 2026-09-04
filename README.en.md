# Yurucommu

Japanese: [README.md](README.md)

Yurucommu is a self-hostable social network for feeds, stories, profiles,
communities, and direct messages. It supports ActivityPub, the standard that
lets independent social servers exchange follows and posts.

This repository contains the web app and server, a mock API for local
development, a provider-neutral [resource contract](deploy/product-resources.json),
deployment adapters, and the `yurucommu.com` website.

## Quick local start

Install [Bun](https://bun.sh/), then run:

```bash
bun install
bun run dev:mock
```

Open <http://localhost:5173>. You can test posts, stories, direct messages,
communities, and notifications without an external server. Mock data stays in
memory and disappears when the process stops.

To start on the signed-out screen:

```bash
YURUCOMMU_MOCK_AUTH=signed-out bun run dev:mock
```

To connect only the web app to an existing Yurucommu API:

```bash
YURUCOMMU_DEV_PROXY_TARGET=http://localhost:8787 bun run dev
```

## Main features

- Feed posts, replies, reactions, and search
- Image and video stories
- Profiles and communities with configurable visibility
- Direct messages with people and communities
- In-app notifications and optional browser push notifications
- ActivityPub delivery to other compatible servers

## Choose where to run it

| Goal                    | Use                                            | Data location                                |
| ----------------------- | ---------------------------------------------- | -------------------------------------------- |
| Try the UI              | `bun run dev:mock`                             | Memory; cleared on exit                      |
| Run on Takoserver       | [`deploy/takoform`](deploy/takoform/README.md) | Independent Resources provided by Takoserver |
| Self-host on Cloudflare | Root `main.tf` or `wrangler.jsonc`             | D1, R2, Workers KV, and Queues               |

Yurucommu owns the logical resource roles and connection names. The
`deploy/takoform` module and root `main.tf` map that same contract to a
Takoform host and direct Cloudflare respectively. Takosumi runs either as an
ordinary OpenTofu module; product code does not know which adapter was chosen.

### Install on Takosumi

Pass the Git URL to Takosumi's New app or `/install` screen. The site CTA uses
this same canonical entrypoint:

```text
https://app.takosumi.com/install?git=https%3A%2F%2Fgithub.com%2Ftako0614%2Fyurucommu.git
```

Takosumi scans the OpenTofu tree at one Git revision and derives the real root
modules and each module's Provider requirements. This repository has two
candidates, the root and `deploy/takoform`, so the install screen asks which
one to run. There is no separate source-options document. Adjust the ref,
module path, or service name only when needed.

If a Takosumi host lists Yurucommu in its browse screen, that entry enters the
same Git URL and tree scan. The list is a discovery shortcut, not a different
distribution or module authority.

The install screen reads
[`/.well-known/takosumi.json`](.well-known/takosumi.json) from the selected
ref. Its `install.modules` entries can add input, build, service, and interface
assistance only to modules proven to exist by the tree scan; they cannot create,
order, or default candidates. Takosumi still owns cloud credentials, secrets,
the public URL, migrations, and runtime authorization.

Takosumi's Cloudflare profile uses Takosumi Accounts OIDC. The initial install
screen does not accept an initial password or an authenticated push-gateway
token because that path has no sealed input transport. A gateway that needs no
token can still use its URL and public key. Token-authenticated gateways remain
a manual self-hosting concern until sealed install inputs exist.

1. Pass the Git URL.
2. Let Takosumi sync the source tree and manifest and show what it will create.
3. Review the Plan.
4. Run Apply.
5. Open Yurucommu from the Apps screen.

After installation, the `WorkerEndpoint` created after `WorkerDeployment`
returns the ordinary `launch_url` output. The reviewed v2.3
[`interfaces`](.well-known/takosumi.json)
declaration compiles to an `interface.ui.surface@1` Interface whose `inputs.url`
explicitly references that `launch_url` output. The output alone does not create
an Apps-screen surface; permission to open it remains a separate binding. No layer
guesses a URL from provider-specific resource IDs.

Automation can also read the ordinary `launch_url` and `api_url` OpenTofu
outputs. If the Apps screen has no link, check the Apply result, readiness of
`WorkerDeployment` and `WorkerEndpoint`, `launch_url`, and the installer's access.

See [`deploy/takoform/README.md`](deploy/takoform/README.md) for the resources
declared by the app and the configuration that remains the host's
responsibility.

### Self-host on Cloudflare

The root [`main.tf`](main.tf) is an OpenTofu module that can create the Worker
and its Cloudflare resources. Its main inputs are:

- the Cloudflare account ID;
- the Worker name and public URL;
- a 64-character hexadecimal encryption key; and
- an initial password or OIDC configuration.

Do not write secret values to the repository or plaintext Worker variables.
Pass them through sensitive OpenTofu inputs or Cloudflare Secrets. Review the
database, storage, queues, Worker, and public URL in `tofu plan` before
applying.

[`wrangler.jsonc`](wrangler.jsonc) is the direct Worker configuration for
resources that already exist. You must supply real IDs or names for D1, R2, KV,
and the two Queues, together with the authentication Secrets.

Publishing code and changing the database are separate operations. Updating
the Worker does not run SQL migrations. For an existing installation, inspect
the current migration history and prepare backup and recovery steps before
changing the schema.

## Data and runtime

Yurucommu needs the following roles on every supported host:

| Role            | What it stores or runs                                     | Cloudflare mapping             |
| --------------- | ---------------------------------------------------------- | ------------------------------ |
| SQL database    | Accounts, posts, follows, notifications, and other records | D1                             |
| Object storage  | Images and videos from posts and stories                   | R2                             |
| Key-value store | Sessions, sign-in attempt limits, and rate limits          | Workers KV                     |
| Delivery queues | Asynchronous ActivityPub delivery and retries              | Queues and a dead-letter queue |
| Scheduler       | Removal of expired data                                    | Hourly Cron Trigger            |
| HTTP service    | Web app and API                                            | Worker                         |

`@takosjp/yurucommu-core` owns the database schema. The Takosumi-managed path
pins one self-contained bundle generated from the exact installed and locked
core package, including every SQL body and digest, in
[`deploy/takoform/migrations/schema-bundle.json`](deploy/takoform/migrations/schema-bundle.json),
then asks the selected host to converge the schema as part of the database
resource Apply. The database is not Ready until that finishes. The person
maintaining a Cloudflare self-host owns the equivalent migration history and
recovery procedure.

The web app uses Solid and Vite. `@takosjp/yurucommu-core` supplies the
ActivityPub, authentication, API, and database behavior, while
`@takosjp/yurucommu-api` provides typed client calls.

## Notifications

In-app notifications work without additional infrastructure. Browser Web Push
while the app is closed is optional. Yurucommu does not request browser
permission until a person enables it in Settings.

Push payloads do not contain post or direct-message content. A notification
opens Yurucommu's notification view, which retrieves the content from the
authenticated API.

The Cloudflare OpenTofu path accepts three Web Push inputs:

| Input                                   | Purpose                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `notification_push_gateway_url`         | HTTPS notification endpoint                              |
| `notification_push_gateway_token`       | Optional Secret when the gateway requires authentication |
| `notification_push_web_push_public_key` | Public VAPID key sent to browsers                        |

Configure the URL and public key together. Keep the matching private key at the
gateway; never store it in the Yurucommu database, browser, or OpenTofu
outputs.

`deploy/takoform` does not put push secrets in state. A managed host that
offers Web Push must inject the URL and public key at runtime, together with a
token only when its gateway requires one.

## Operations and troubleshooting

Run the full repository check before sending a change:

```bash
bun run check
```

It checks formatting, types, OpenTofu, tests, and the Worker build. Use
`bun run build:worker` to check only the Worker. Do not commit the generated
`dist/yurucommu-worker.js`.

Check a running server with `GET /healthz`. A partially configured runtime can
still return HTTP 200 with `status: "degraded"`, so inspect both `status` and
`missingBindings`. `GET /readyz` returns 503 when the database, KV, public URL,
encryption key, or authentication method is missing. `GET
/.well-known/social-server` returns client-facing capability information.

### The page opens, but API calls fail

Use `bun run dev:mock` for local development, or verify that
`YURUCOMMU_DEV_PROXY_TARGET` points at the real API. The default API target is
`http://localhost:8787`.

### `healthz` reports missing connections

Verify that the HTTP service has `DB`, `MEDIA`, `KV`, `DELIVERY_QUEUE`, and
`DELIVERY_DLQ`. On Cloudflare, compare the `wrangler.jsonc` bindings with the
real resource IDs and names. On Takosumi, inspect the Apply result and Resource
connections.

### Sign-in fails

Password authentication requires `AUTH_PASSWORD_HASH`, and every setup needs
`ENCRYPTION_KEY`. For OIDC, verify the issuer, client ID, callback URL, and the
subject selected as the initial owner. Never paste secret values into logs or
issues.

### Yurucommu is missing from the Apps screen

A successful Apply is not enough if the `launch_url` from `WorkerEndpoint.url`
is unresolved, the UI surface compiled from the v2.3 `interfaces` declaration
is unresolved, or the current account lacks permission to open it. Inspect the
Endpoint output and Interface instead of constructing a URL from a cloud
resource ID.

### Browser push does not arrive

Check browser permission first, then confirm that the gateway URL and public
VAPID key were configured together. If the gateway requires authentication,
also verify that the Worker received its token as a Secret. Web Push requires
HTTPS.

### Delivery to another server is stalled

Inspect the delivery Queue consumer and the dead-letter queue. Do not retry
indefinitely by hand; first identify the delivery, final error, and retry
count.

Repository maintainers update the existing production Worker through the
single entrypoint:

```bash
YURUCOMMU_WORKER_DEPLOY_TARGET=/absolute/operator-private/production-target.json \
CLOUDFLARE_API_TOKEN='...' \
YURUCOMMU_E2E_PASSWORD='...' \
bun run deploy -- yurucommu-worker \
  --environment=production \
  --commit="$(git rev-parse HEAD)"
```

The operator-private JSON target descriptor contains no secrets. It fixes the
production account, `yurucommu` script, `test.yurucommu.com` custom domain, and
the absolute path and SHA-256 of the realized JSON/JSONC config. The config is
limited to `name`, `account_id`, the selected bundle `main`, `compatibility_date`,
and (when present) runtime flags, limits, or usage model that must match the
authoritative active Version. Vars, bindings, routes, triggers, queues,
migrations, secrets, and assets are authority outside this code-only surface
and are rejected. Existing bindings are inherited strictly from the active
Version and the uploaded Version's full non-code closure is compared with it.
Its kind is `yurucommu.worker-deploy-target@v1`; use the descriptor shape in the
Japanese README and never commit its production values. Keep both the
descriptor and config as mode `0600` regular files in a mode `0700`
operator-private directory outside the repository, its Git common directory,
linked worktrees, and every other discovered Git repository; links and broader
permissions are rejected.

This code-only surface sends exactly one multipart POST to Cloudflare's Version
Upload API, pins every inherited binding to the pre-upload active Version ID,
verifies the source commit / bundle / config annotation, the authoritative
`resources.script.etag` against the uploaded bundle bytes, and the non-code
Version closure (bindings, vars, compatibility/runtime settings, limits, and
lifecycle fields), and then creates exactly one
Cloudflare Deployment at 100% for that Version. It reads the predecessor from
the pre-upload active Deployment, not Version-list order. After deployment it
re-reads the active Deployment, Version, and exact hostname/service/environment
custom-domain inventory across bounded stable pages, runs the real
request smoke, then re-reads the route and active Deployment before reporting
`PUBLISHED`. A failed smoke is never rolled back automatically: Cloudflare has
no compare-and-swap across the read → write boundary, so the exact predecessor
and observed active Deployment are reported as `INDETERMINATE` for manual
reversal. A lost upload/deploy acknowledgement is `INDETERMINATE` and is never
retried automatically.

It does not run `wrangler deploy`, trigger deployment, D1 migrations, or secret
updates. Route, cron/queue consumer, schema/data, and secret changes remain
separate operations. Inspect all requirements without side effects with
`bun run deploy -- --contract`.
The Worker surface requires `git`, `bun`, and `tofu` in addition to the
operator-private environment above.

The readback contract follows Cloudflare's primary
[Versions and Deployments](https://developers.cloudflare.com/workers/versions-and-deployments/),
[Version Upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/),
and [Deployments API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/)
documentation.

## Repository guide

- [`src/`](src/) — web app
- [`scripts/dev-mock-server.ts`](scripts/dev-mock-server.ts) — local mock API
- [`scripts/build-yurucommu-worker.ts`](scripts/build-yurucommu-worker.ts) — Worker build
- [`deploy/takoform/`](deploy/takoform/) — definition for Takosumi and other managed hosts
- [`main.tf`](main.tf) — OpenTofu module for Cloudflare self-hosting
- [`site/`](site/) — static `yurucommu.com` site, help, and protocol documents
- [`site/DEPLOY.md`](site/DEPLOY.md) — website publication guide
