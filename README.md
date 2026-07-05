# Yurucommu

Official feed / story / profile client for yurucommu.

The server, ActivityPub implementation, API contract, OpenTofu Capsule, and
`@takosjp/yurucommu-api` package live in `yurucommu-core`. This repo depends on
the published SDK and connects to a yurucommu-core server through same-origin
proxying, `VITE_YURUCOMMU_SERVER_URL`, query-string configuration, or Takosumi
Capsule outputs.

## Develop

```bash
bun install
bun run dev
bun run check
bun run test
bun run build
```

`site/` contains the public `yurucommu.com` brand/help/static namespace content.
