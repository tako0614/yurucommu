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
bun run build:takos-worker
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
server URLs, and `takosumi_release` activation commands. The default Worker
artifact path is `dist/takos-worker.js`; build it with `bun run
build:takos-worker`.
