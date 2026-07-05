# AGENTS.md — yurucommu

`yurucommu` は feed / story / profile 中心の公式 client repo です。
server / ActivityPub / API / OpenTofu Capsule は `yurucommu-core` が所有し、
この repo は `@takosjp/yurucommu-api` と `/.well-known/social-server`、
または Takosumi Capsule outputs で server に接続します。

## 責務

- yurucommu 公式 web client
- `yurucommu.com` / `yurucommu.test` の brand / help site
- frontend plugin API
- same-origin or configured-origin server connection UX

## 持たない

- ActivityPub federation implementation
- DB schema / migrations
- OpenTofu Capsule server module
- Worker release artifact for yurucommu-core

## Workflow

```bash
bun install
bun run check
bun run test
bun run build
```
