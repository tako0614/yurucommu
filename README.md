# Yurucommu

English: [README.en.md](README.en.md)

Yurucommu は、フィード・ストーリー・プロフィールを備えた、自分のサーバーで運営できる
コミュニティ SNS です。ActivityPub (サーバー同士がつながる分散 SNS の共通プロトコル) に
対応しているので、ほかのサーバーのユーザーともつながれます。

この repo は yurucommu の公式 fullstack product で、web UI・`yurucommu.com` サイト・
Worker artifact・plain な OpenTofu Capsule を持ちます。共有の ActivityPub / API エンジンである
`@takosjp/yurucommu-core` を組み込み、型付きのクライアント呼び出しには
`@takosjp/yurucommu-api` を使います。

## 始め方 (開発)

```bash
bun install
bun run dev
bun run dev:mock
bun run check
bun run test
bun run build
bun run build:worker
```

`bun run dev:mock` は、web UI と in-memory の yurucommu 互換 mock API を一緒に起動します。
mock API はパスワード認証・タイムライン・ストーリー・DM・コミュニティ・通知・検索・
プロフィールの endpoint を実装しているので、サーバーなしで UI 開発ができます。ログイン画面を
テストしたいときは `YURUCOMMU_MOCK_AUTH=signed-out bun run dev:mock` を使います。

`site/` には、公開している `yurucommu.com` のブランド・ヘルプ・静的コンテンツが入っています。

## デプロイ方法

Yurucommu には、対等な2つの導入方法があります。

### Cloudflareへ直接デプロイ

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/tako0614/yurucommu)
を使うか、CloudflareへログインしたCLIから標準のWrangler設定でデプロイできます。

```bash
bunx wrangler d1 create yurucommu-db
bunx wrangler queues create yurucommu-delivery
bunx wrangler queues create yurucommu-delivery-dlq
bunx wrangler secret put ENCRYPTION_KEY
bunx wrangler secret put AUTH_PASSWORD_HASH
bun run deploy
```

`wrangler.jsonc` が直接デプロイの正本です。`bun run deploy` はfullstack Workerをビルドし、
共有coreのD1 migrationを適用してから `wrangler deploy` を実行します。KVとR2はWranglerが
初回deploy時にprovisionします。CloudflareのDeployボタンではD1・KV・R2・Queuesもセットアップされます。

### Takosumiでインストール

この repo は、通常の plain OpenTofu module として Takosumi からインストールできます
(Capsule は Git URL から取り込む 1 つのアプリ/インフラ単位です)。

```json
{
  "url": "https://github.com/tako0614/yurucommu.git",
  "ref": "main",
  "path": "."
}
```

`main.tf` が任意の Cloudflare D1 / R2 / KV / Queue / Worker リソースを作成します。
`outputs.tf` は通常の `launch_url` / `api_url` と provider-native resource ID
だけを公開します。migration が必要な環境では、operator が Takosumi の
service-side InstallConfig に versioned lifecycle action と policy を設定します。
OpenTofu Output に Takosumi 専用 hook や予約 schema は置きません。
Worker artifact の既定パスは `dist/yurucommu-worker.js` で、ローカル/self-host の apply では
`bun run build:worker` でビルドします。

hosted 環境からのインストールでは、Git release や CI artifact の
`worker_bundle_url` + `worker_bundle_sha256` を渡してください。`dist/yurucommu-worker.js` などの
ビルド出力は repo に commit しません。

OpenTofuはこのTakosumi管理経路でPlan・Apply・StateVersion・Output・Auditを扱うためのものです。
Cloudflareへ直接デプロイするだけならOpenTofuは必要ありません。

[`install-options.json`](install-options.json) は、現在実行可能な Cloudflare OpenTofu module を選ぶための任意の
`CapsuleSourceOptions` 表示ドキュメントです。Takosumi 専用 manifest ではなく、通常の Git URL + module path での
直接インストールには不要です。この文書は、それを含む次の通常の安定版タグから利用できます。別クラウドの選択肢は、
対応する実在 module を出荷したときだけ追加します。

## ブラウザ通知

ブラウザ通知は設定画面から明示的に有効化します。ページを開いただけでは通知権限を要求しません。
通知には投稿本文などを載せず、service worker は通知を受けたあと Yurucommu の通知画面を開きます。

OpenTofu で Worker を作る場合は、次の 3 変数を設定します。

- `notification_push_gateway_url` — stateless push gateway の公開 HTTPS notify endpoint
- `notification_push_gateway_token` — Worker だけが gateway 呼び出しに使う secret bearer
- `notification_push_web_push_public_key` — gateway の公開 VAPID key（秘密値ではありません）

gateway URL と公開 VAPID key は必ず一緒に設定します。対応する VAPID private key は gateway 側だけに置き、
Yurucommu の DB・browser・OpenTofu Output には保存しません。ローカルの UI 開発で runtime API がまだない場合だけ、
`VITE_YURUCOMMU_NOTIFICATION_PUSH_GATEWAY_URL` と `VITE_YURUCOMMU_WEB_PUSH_PUBLIC_KEY` を build-time fallback
として利用できます。
