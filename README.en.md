日本語: [README.md](README.md)

# Yurucommu

Official feed / story / profile fullstack product for yurucommu.

This repo owns the web UI, `yurucommu.com` site, Worker artifact, and plain
OpenTofu Capsule. It embeds the shared ActivityPub / API engine from
`@takosjp/yurucommu-core` and uses `@takosjp/yurucommu-api` for typed client
calls.

## Develop

```bash
bun install
bun run dev
bun run dev:mock
bun run check
bun run test
bun run build
bun run build:worker
```

`bun run dev:mock` starts the web UI and an in-memory yurucommu-compatible mock
API together. The mock API implements password auth, timeline, stories, DMs,
communities, notifications, search, and profile endpoints for UI development.
Use `YURUCOMMU_MOCK_AUTH=signed-out bun run dev:mock` when you need to test the
login screen.

`site/` contains the public `yurucommu.com` brand/help/static namespace content.

## Deploy

Yurucommu has two equal installation paths.

### Deploy directly to Cloudflare

Use [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/tako0614/yurucommu),
or deploy from an authenticated CLI with the standard Wrangler configuration:

```bash
bunx wrangler d1 create yurucommu-db
bunx wrangler queues create yurucommu-delivery
bunx wrangler queues create yurucommu-delivery-dlq
bunx wrangler secret put ENCRYPTION_KEY
bunx wrangler secret put AUTH_PASSWORD_HASH
bun run deploy
```

`wrangler.jsonc` is the source of truth for direct deployment. `bun run deploy`
builds the fullstack Worker, applies the shared core D1 migrations, and runs
`wrangler deploy`. Wrangler provisions KV and R2 on the first deploy. The
Deploy to Cloudflare flow also provisions D1, KV, R2, and Queues.

### Install through Takosumi

Install this repo through Takosumi as a normal plain OpenTofu module:

```json
{
  "url": "https://github.com/tako0614/yurucommu.git",
  "ref": "main",
  "path": "."
}
```

`main.tf` provisions the optional Cloudflare D1 / R2 / KV / Queue / Worker
resources. `outputs.tf` publishes only ordinary `launch_url` / `api_url`
results and provider-native resource IDs. When an environment needs a
migration, its operator configures a versioned lifecycle action and policy in
Takosumi's service-side InstallConfig. No Takosumi hook or reserved schema is
stored in an OpenTofu Output. The default Worker artifact path is
`dist/yurucommu-worker.js`; build it
with `bun run build:worker` for local/self-host applies.

Hosted installs should pass `worker_bundle_url` + `worker_bundle_sha256` from a
Git release or CI artifact. Do not commit `dist/yurucommu-worker.js` or other
build outputs to the repository.

OpenTofu belongs to this Takosumi-managed path because it adds Plan, Apply,
StateVersion, Output, and Audit management. A direct Cloudflare deployment does
not require OpenTofu.

## Browser notifications

Browser notifications are an explicit opt-in in Settings. Merely opening the
app never prompts for notification permission. Pushes contain no post or DM
content; the service worker wakes the client and opens Yurucommu's notification
view.

When OpenTofu creates the Worker, configure these variables:

- `notification_push_gateway_url` — public HTTPS notify endpoint of the
  stateless push gateway
- `notification_push_gateway_token` — secret bearer used only by the Worker
  when it calls that gateway
- `notification_push_web_push_public_key` — the gateway's public VAPID key
  (not a secret)

The gateway URL and public VAPID key must be configured together. Keep the
matching VAPID private key only at the gateway; it is never stored in the
Yurucommu database, browser, or OpenTofu outputs. For local UI development
against an older server only, `VITE_YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_URL`
and `VITE_YURUCOMMU_WEB_PUSH_PUBLIC_KEY` provide a build-time fallback.
