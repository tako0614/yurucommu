# AGENTS.md — yurucommu

`yurucommu` は feed / story / profile 中心の fullstack product repo です。
UI、Worker artifact、OpenTofu Capsule、`yurucommu.com` site をこの repo が所有し、
server engine は `@takosjp/yurucommu-core` library として組み込みます。

## 責務

- yurucommu 公式 web client
- `yurucommu.com` / `yurucommu.test` の brand / help site
- frontend plugin API
- yurucommu Worker artifact (`dist/takos-worker.js`)
- OpenTofu Capsule module (`main.tf` / `outputs.tf`)
- app-owned Takosumi release hook / D1 migration activation
- same-origin fullstack runtime and configured-origin development UX

## 持たない

- reusable ActivityPub / API / DB engine implementation (`yurucommu-core`)
- Takosumi platform federation responsibility
- Yurumeet talk-first UI / site

## Workflow

```bash
bun install
bun run check
bun run test
bun run build
bun run build:takos-worker
```

## Version discipline

`package.json` and `outputs.tf` versions describe the yurucommu product release.
Do not bump the product major version just because dependencies, licensing, or
repo topology changed; major releases need an explicit product release decision.
