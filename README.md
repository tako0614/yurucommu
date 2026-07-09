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

## Installable Capsule

Install this repo through Takosumi as a normal plain OpenTofu module:

```text
repositoryUrl = "https://github.com/tako0614/yurucommu.git"
modulePath    = "."
```

`main.tf` provisions the optional Cloudflare D1 / R2 / KV / Queue / Worker
resources. `outputs.tf` publishes `service_exports`, `service_bindings`, social
server URLs, and a `takosumi_release` migration hook for the OpenTofu-managed
Worker. The default Worker artifact path is `dist/yurucommu-worker.js`; build it
with `bun run build:worker` for local/self-host applies.

Hosted installs should pass `worker_bundle_url` + `worker_bundle_sha256` from a
Git release or CI artifact. Do not commit `dist/yurucommu-worker.js` or other
build outputs to the repository.
