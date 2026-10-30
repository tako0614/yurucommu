# Cloudflare へ直接インストールする module

`deploy/cloudflare` は、Takosumi の Cloudflare 接続から Yurucommu を利用者の
Cloudflare アカウントへ直接置く OpenTofu module です。公式の
`cloudflare/cloudflare` Provider だけを使い、Takoform Host や Takoserver を
経由しません。`deploy/takoform` と同じ製品契約
（[`deploy/product-resources.json`](../product-resources.json)）を Cloudflare の
リソースへ写します。

## 作るもの

| 役割                     | Cloudflare リソース                         | Worker の接続名                |
| ------------------------ | ------------------------------------------- | ------------------------------ |
| HTTP サービス            | Worker（`<project_name>`）                  | —                              |
| SQL データベース         | D1（`<project_name>-db`、読み取り複製なし） | `DB`                           |
| キー・バリューストア     | Workers KV（`<project_name>-kv`）           | `KV`                           |
| メディア                 | R2（`<project_name>-media`）                | `MEDIA`                        |
| 配送キュー               | Queue（`<project_name>-delivery`）          | `DELIVERY_QUEUE`               |
| 失敗した配送の退避       | Queue（`<project_name>-delivery-dlq`）      | `DELIVERY_DLQ`                 |
| 配送・修復の consumer    | 各 Queue に Worker consumer を1つ           | `queue` handler                |
| 定期整理                 | 1時間ごとの Cron Trigger                    | `scheduled` handler            |
| 公開 URL                 | workers.dev、または Workers Custom Domain   | `APP_URL`                      |
| 暗号化キー・session salt | `random_bytes`（state に保持）              | `ENCRYPTION_KEY` などの Secret |

Worker は `YURUCOMMU_RUNTIME_LANE=cloudflare`（生の D1・KV・R2・Queue binding）
で動きます。互換日付と flag は公式の [`wrangler.jsonc`](../../wrangler.jsonc) と
同じです。Durable Object は使いません。

## データベースのスキーマ

`cloudflare/cloudflare` Provider は D1 を作れますが、SQL を流すリソースは
ありません。直接インストールには Takoform Host もいません。そこで、この module が
置く Worker は製品のスキーマを自分の D1 へ適用してから処理を始めます
（`YURUCOMMU_APPLY_BUNDLED_MIGRATIONS=true`）。

- 適用するのは、ロック済みの `@takosjp/yurucommu-core` から作った
  [`schema-bundle.json`](../takoform/migrations/schema-bundle.json) です。
  Takoform module と同じバイト列で、0003 は D1 で安全な作り直し版です。
  ビルド時に1文ずつへ分け、Worker に埋め込みます。
- 台帳は core の runner と `wrangler d1 migrations apply`
  （`migrations_table: yurucommu_migrations`）と同じ `yurucommu_migrations` です。
- 1ファイルを D1 の `batch` 1回（1トランザクション）で適用し、台帳の行をその
  先頭に置きます。複数の isolate が同時に始めても、後から来た batch は台帳の
  一意制約で何もせずに巻き戻るので、各ファイルは一度だけ適用されます。
- 失敗したファイルはスキーマも台帳も残さず巻き戻ります。Worker は
  `503 schema_unavailable` を返し、Queue と Cron の処理も再試行に回します。
  原因は Workers Logs（`yurucommu.schema.failed`）に出ます。
- 前進のみです。台帳にない既知のファイルをファイル名順に適用し、台帳の行を
  書き換えたり消したりしません。
- 既定では無効です。この変数を設定しない Worker（ルートの `main.tf`、
  `wrangler.jsonc`、Takoform Host、yurucommu.com の本番）は、これまでどおり
  運用者や Host がスキーマを管理します。portable lane で有効にすると起動を拒否します。

既存データのある環境で新しいスキーマを含む版へ更新すると、新しい Worker の
最初のリクエストがそのファイルを適用します。適用中、新しい版のリクエストは完了を
待ちます。旧版の処理中リクエストは D1 が直列化するため、適用のトランザクションと
混ざりません。それでも「書き込みを止めて適用する」と書かれた移行
（core の [migrations README](https://github.com/tako0614/yurucommu-core/blob/main/migrations/README.md)）
を含む更新では、事前にバックアップを取ってください。

## 入力

Takosumi の Cloudflare 接続は、確認済みの `cloudflare_account_id` と
`cloudflare_workers_subdomain` を同名の変数へ渡します。インストール画面で
尋ねるのは次だけです。

- `app_url`（必須）: `https://<サービス名>.<workers.dev サブドメイン>.workers.dev`。
  Takosumi はこの origin に `/api/auth/callback/takos` を足した URL で
  Takosumi Accounts の OIDC client を登録し、発行者・client ID・redirect URI を
  変数で渡します。workers.dev の URL は Worker 名と接続のサブドメインに一致する
  必要があります。独自ドメインの場合は `cloudflare_zone_id` も指定し、
  Workers Custom Domain として割り当てます。
- `allow_unpinned_owner_claim`: Takosumi は直接インストールの所有者を変数で渡せない
  ため、OIDC だけでサインインする構成では、最初にサインインした人が所有者になる
  ことを明示的に受け入れる必要があります。導入後すぐに自分でサインインし、
  必要なら後で `oidc_owner_sub` を固定してください。
- `notification_push_gateway_url`（任意）: ネイティブアプリ用の Push gateway。

`ENCRYPTION_KEY` と `YURUCOMMU_SESSION_HASH_SALT` は、空なら module が
`random_bytes` で一度だけ作り、OpenTofu の state に保持します（`secret_text`
binding も state に値を持ちます）。Takosumi の `secret.generated` は現在
Takoform Host にしか届かないためです。既存インスタンスを引き継ぐ場合だけ
`encryption_key` と `session_hash_salt` を指定します。稼働中のインスタンスで
どちらも変えないでください。

## 直接 OpenTofu で使う

```bash
bun install --frozen-lockfile
bun run build:worker
bun scripts/prepare-cloudflare-source.ts
cd deploy/cloudflare
export CLOUDFLARE_API_TOKEN=...   # Workers・D1・KV・R2・Queues を編集できるトークン
tofu init
tofu apply \
  -var cloudflare_account_id=<account id> \
  -var cloudflare_workers_subdomain=<workers.dev subdomain> \
  -var project_name=<name> \
  -var auth_password_hash=<PBKDF2 salt:hash または初回用トークン>
```

`prepare-cloudflare-source.ts` は、Worker がスキーマ適用の仕組みと全ての
migration を埋め込んでいることを確かめてから `.generated/` に置きます。
`tofu destroy` は Worker、D1（データを含む）、KV、Queue、R2 を削除します。R2 は
空でないと削除できません。

## 検証

`bun run check` は次を実行します。

- `deploy/cloudflare` の `tofu validate` と、mock Provider による plan-only の
  `tofu test`（binding、名前、consumer、Cron、URL、認証の前提条件）。
- 分割器と runner の単体テスト。SQLite 自身で各片が1文であり、全体が
  ファイル単位の実行と同じスキーマになることを確かめます。
- `smoke:release-d1-schema`: 実際の workerd D1（Miniflare）で、ビルドした Worker が
  空の D1 を同時アクセス下で一度だけ移行し、ファイル単位の適用と同じスキーマに
  なり、初回サインインまで通ることを確かめます。
