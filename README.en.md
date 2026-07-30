# Yurucommu

Japanese: [README.md](README.md)

Yurucommu is a self-hostable social network for feeds, stories, profiles,
communities, and direct messages. It supports ActivityPub, the standard that
lets independent social servers exchange follows and posts.

This repository contains the web app, the server Worker, a mock API for local
development, deployment definitions, and the `yurucommu.com` website.

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

| Goal                    | Use                                            | Data location                                 |
| ----------------------- | ---------------------------------------------- | --------------------------------------------- |
| Try the UI              | `bun run dev:mock`                             | Memory; cleared on exit                       |
| Run on Takosumi         | [`deploy/takoform`](deploy/takoform/README.md) | The database and storage selected by the host |
| Self-host on Cloudflare | Root `main.tf` or `wrangler.jsonc`             | D1, R2, Workers KV, and Queues                |

Takosumi is a host that creates runtime resources from Git and records plans,
applies, outputs, and change history. A Takosumi-managed installation and a
Cloudflare self-host are separate paths. The managed path does not require
Cloudflare to be part of the app definition.

### Install on Takosumi

Enter the following in Takosumi's New app or `/install` screen:

| Field   | Value                                       |
| ------- | ------------------------------------------- |
| Git URL | `https://github.com/tako0614/yurucommu.git` |
| ref     | A stable release tag or reviewed commit     |
| path    | `deploy/takoform`                           |
| name    | Any service name, such as `yurucommu`       |

If a Takosumi host lists Yurucommu in its browse screen, that entry resolves to
the same `deploy/takoform` module. The list is a discovery shortcut, not a
different distribution.

The install screen reads
[`/.well-known/takosumi.json`](.well-known/takosumi.json) from the selected
ref. This repository-owned file describes labels and defaults only. Takosumi
still owns cloud credentials, secrets, the public URL, migrations, and runtime
authorization.

1. Enter the Git URL, ref, and path.
2. Let Takosumi sync the source and show what it will create.
3. Review the Plan.
4. Run Apply.
5. Open Yurucommu from the Apps screen.

After installation, Takosumi resolves the public URL through the EdgeWorker's
declared `http.request@1` Interface. IaC reads its `resource_uri` as the ordinary
`launch_url` output, and Takosumi turns that output into the Apps-screen UI
surface. Permission to open it remains a separate record. No layer guesses a
URL from provider-specific resource IDs.

Automation can also read the ordinary `launch_url` and `api_url` OpenTofu
outputs. If the Apps screen has no link, check the Apply result, the
EdgeWorker's `http.request@1`, `launch_url`, and the installer's access.

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
pins the package version and every SQL digest in
[`deploy/takoform/migrations/manifest.json`](deploy/takoform/migrations/manifest.json),
then runs that migration after Apply. The person maintaining a Cloudflare
self-host owns the equivalent migration history and recovery procedure.

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

A successful Apply is not enough if `http.request@1` has no `resource_uri`,
`launch_url` or the UI surface is unresolved, or the current account lacks
permission to open it. Inspect the Interface and Output instead of constructing
a URL from a cloud resource ID.

### Browser push does not arrive

Check browser permission first, then confirm that the gateway URL and public
VAPID key were configured together. If the gateway requires authentication,
also verify that the Worker received its token as a Secret. Web Push requires
HTTPS.

### Delivery to another server is stalled

Inspect the delivery Queue consumer and the dead-letter queue. Do not retry
indefinitely by hand; first identify the delivery, final error, and retry
count.

Repository maintainers publish Worker code through the single
`bun run deploy -- yurucommu-worker` entrypoint. It does not modify the
database. Inspect its requirements without side effects with
`bun run deploy -- --contract`.

## Repository guide

- [`src/`](src/) — web app
- [`scripts/dev-mock-server.ts`](scripts/dev-mock-server.ts) — local mock API
- [`scripts/build-yurucommu-worker.ts`](scripts/build-yurucommu-worker.ts) — Worker build
- [`deploy/takoform/`](deploy/takoform/) — definition for Takosumi and other managed hosts
- [`main.tf`](main.tf) — OpenTofu module for Cloudflare self-hosting
- [`site/`](site/) — static `yurucommu.com` site, help, and protocol documents
- [`site/DEPLOY.md`](site/DEPLOY.md) — website publication guide
