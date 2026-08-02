# Yurucommu

English: [README.en.md](README.en.md)

Yurucommu は、フィード、ストーリー、プロフィール、コミュニティ、ダイレクト
メッセージをひとつにまとめた SNS です。自分でサーバーを運用でき、ActivityPub
（異なる SNS サーバー同士をつなぐ共通仕様）を通じて、ほかのサーバーのユーザーとも
やり取りできます。

このリポジトリには Web アプリとサーバー用の Worker、ローカル開発用のモック API、
デプロイ設定、`yurucommu.com` のサイトが入っています。

## 最短でローカル起動

[Bun](https://bun.sh/) を用意し、次の2コマンドを実行します。

```bash
bun install
bun run dev:mock
```

ブラウザで <http://localhost:5173> を開いてください。投稿、ストーリー、DM、
コミュニティ、通知などを、外部サーバーなしで試せます。モックのデータはメモリ上に
だけ保存され、プロセスを止めると消えます。

ログアウト状態から確認する場合は、次のように起動します。

```bash
YURUCOMMU_MOCK_AUTH=signed-out bun run dev:mock
```

既存の Yurucommu API に Web アプリだけをつなぐ場合は、接続先を指定して
`bun run dev` を使います。

```bash
YURUCOMMU_DEV_PROXY_TARGET=http://localhost:8787 bun run dev
```

## 主な機能

- フィードへの投稿、返信、リアクション、検索
- 画像や動画を使ったストーリー
- 公開範囲を選べるプロフィールとコミュニティ
- ユーザーやコミュニティとのダイレクトメッセージ
- アプリ内通知と、任意で有効にできるブラウザのプッシュ通知
- ActivityPub による、別の対応サーバーとのフォローや投稿配送

## どこで動かすか

| 目的                        | 使うもの                                       | データの置き場所                                          |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| UI をすぐ試す               | `bun run dev:mock`                             | メモリ。終了時に消える                                    |
| Takosumi で運用する         | [`deploy/takoform`](deploy/takoform/README.md) | Takosumi が選んだデータベース、オブジェクトストレージなど |
| Cloudflare で自分で運用する | ルートの `main.tf` または `wrangler.jsonc`     | D1、R2、Workers KV、Queues                                |

Takosumi は、Git に置かれた設定から実行環境を作り、変更計画、適用結果、履歴を管理する
ホストです。Takosumi での運用と Cloudflare へのセルフホストは別の経路です。
Cloudflare を Takosumi の内部実装として前提にする必要はありません。

### Takosumi でインストール

Takosumi の「新しいアプリ」または `/install` 画面で、次を指定します。

| 項目    | 値                                           |
| ------- | -------------------------------------------- |
| Git URL | `https://github.com/tako0614/yurucommu.git`  |
| ref     | 使用する安定版タグ、または確認済みのコミット |
| path    | `deploy/takoform`                            |
| name    | 任意のサービス名。例: `yurucommu`            |

一覧画面に Yurucommu が表示される Takosumi ホストでも、選択される実体は同じ
`deploy/takoform` です。一覧は見つけやすくする入口であり、別の配布物ではありません。

インストール画面は、選んだ ref にある
[`/.well-known/takosumi.json`](.well-known/takosumi.json) を読みます。このファイルが
決めるのは入力欄の名前や既定値だけです。クラウドの認証情報、シークレット、公開 URL、
データ移行、実行権限は Takosumi 側が管理します。

1. Git URL、ref、path を入力する
2. Takosumi がソースを同期し、作成するものを表示する
3. Plan で変更内容を確認する
4. Apply を実行する
5. Apps 画面から Yurucommu を開く

インストール後、`EdgeWorker` が宣言する `http.request@1` Interface を使って
Takosumi が公開 URL を解決します。IaC はその `resource_uri` を通常の
`launch_url` Output として取り出します。リポジトリの v2
[`interfaces`](.well-known/takosumi.json) 宣言がレビュー済みの
`interface.ui.surface@1` Interface に compile され、その `inputs.url` が
`launch_url` Output を明示的に参照します。Output だけでは Apps 画面用の surface
は作られず、誰が開けるかは別の binding 権限情報です。Cloudflare などのリソース ID
から URL を推測しません。

自動処理向けには、通常の OpenTofu Output として `launch_url` と `api_url` も
取得できます。Apps 画面にリンクが出ない場合は、Apply の成功、`EdgeWorker` の
`http.request@1`、`launch_url`、インストールした利用者の権限を確認してください。

管理用の定義が作るものと、ホスト側が用意するものは
[`deploy/takoform/README.md`](deploy/takoform/README.md) にまとめています。

### Cloudflare でセルフホスト

ルートの [`main.tf`](main.tf) は、Worker と必要な Cloudflare リソースをまとめて
作る OpenTofu モジュールです。主な入力は次のとおりです。

- Cloudflare の account ID
- 公開する Worker 名と URL
- 64文字の16進数で表した暗号化キー
- 初期パスワード、または OIDC の設定

秘密値はリポジトリや通常の環境変数設定へ書かず、OpenTofu の機密入力または
Cloudflare の Secret として渡してください。`tofu plan` でデータベース、ストレージ、
キュー、Worker、公開 URL を確認してから適用します。

[`wrangler.jsonc`](wrangler.jsonc) は、すでに用意した Cloudflare リソースへ Worker
を直接つなぐ場合の設定です。D1、R2、KV、2本の Queue の実在する ID や名前、
認証用 Secret を別途設定する必要があります。

コードの公開とデータベースの変更は別作業です。Worker を更新しても SQL
マイグレーションは自動では実行されません。既存データがある環境では、利用中の
マイグレーション履歴を確認し、バックアップと復旧方法を用意してから適用してください。

## データと実行環境

Yurucommu は、実行先が変わっても次の役割を必要とします。

| 役割                   | 保存するもの                                 | Cloudflare での対応                   |
| ---------------------- | -------------------------------------------- | ------------------------------------- |
| SQL データベース       | アカウント、投稿、フォロー、通知など         | D1                                    |
| オブジェクトストレージ | 投稿やストーリーの画像・動画                 | R2                                    |
| キー・バリューストア   | セッション、ログイン試行制限、レート制限など | Workers KV                            |
| 配送キュー             | ActivityPub などの非同期配送と再試行         | Queues と、失敗した処理の退避用 Queue |
| 定期実行               | 期限切れデータの整理                         | 1時間ごとの Cron Trigger              |
| HTTP サービス          | Web アプリと API                             | Worker                                |

データベースのスキーマは `@takosjp/yurucommu-core` が管理します。Takosumi の管理経路は
[`deploy/takoform/migrations/manifest.json`](deploy/takoform/migrations/manifest.json)
で対象バージョンと SQL のハッシュを固定し、Apply 後のデータ移行として実行します。
Cloudflare のセルフホストでは、運用者が同じマイグレーション履歴と復旧手順を管理します。

Web アプリは Solid と Vite で構築されています。サーバーの ActivityPub、認証、API、
データベース処理は `@takosjp/yurucommu-core`、型付きのクライアント呼び出しは
`@takosjp/yurucommu-api` を利用しています。

## 通知

アプリ内の通知一覧は追加設定なしで使えます。ブラウザを閉じている間にも通知を届ける
Web Push は任意です。利用者が設定画面で有効にするまで、ブラウザへ通知権限を要求しません。

プッシュ通知の本文には投稿や DM の内容を含めません。受信後は Yurucommu の通知画面を
開き、内容は認証済みの API から読み込みます。

Cloudflare の OpenTofu 経路で Web Push を有効にする場合は、次の項目を設定します。

| 入力                                    | 用途                                    |
| --------------------------------------- | --------------------------------------- |
| `notification_push_gateway_url`         | HTTPS の通知送信先                      |
| `notification_push_gateway_token`       | 送信先が認証を求める場合だけ使う Secret |
| `notification_push_web_push_public_key` | ブラウザへ渡す公開 VAPID 鍵             |

URL と公開鍵は必ず一緒に設定します。対応する秘密鍵は通知送信先だけに保存し、
Yurucommu のデータベース、ブラウザ、OpenTofu Output には置きません。

`deploy/takoform` はプッシュ通知の Secret を状態へ保存しません。Takosumi などの
管理ホストが Web Push を提供する場合は、URL と公開鍵、および必要な場合だけ token
を実行時設定として安全に渡します。

## 運用とトラブルシューティング

変更を送る前の確認は次の1コマンドです。

```bash
bun run check
```

このチェックはフォーマット、型、OpenTofu、テスト、Worker ビルドをまとめて実行します。
Worker だけを確認したい場合は `bun run build:worker` を使います。生成される
`dist/yurucommu-worker.js` は Git に追加しません。

動作中のサーバーは `GET /healthz` で確認できます。設定不足でも HTTP 200 と
`status: "degraded"` を返すことがあるため、`status` と `missingBindings` の両方を
確認してください。`GET /readyz` は、データベース、KV、公開 URL、暗号化キー、
認証方法がそろっていないと 503 を返します。`GET /.well-known/social-server` は
クライアント向けの機能情報を返します。

### 画面は開くが API が失敗する

ローカル開発なら `bun run dev:mock` を使うか、`YURUCOMMU_DEV_PROXY_TARGET` が実際の
API を指しているか確認します。既定の API 接続先は `http://localhost:8787` です。

### `healthz` に不足している接続が表示される

HTTP サービスに `DB`、`MEDIA`、`KV`、`DELIVERY_QUEUE`、`DELIVERY_DLQ` が接続されて
いるか確認します。Cloudflare では `wrangler.jsonc` の binding と実在するリソースの
ID・名前、Takosumi では Apply の実行結果と Resource の接続状態を確認します。

### ログインできない

パスワード認証なら `AUTH_PASSWORD_HASH`、どの構成でも `ENCRYPTION_KEY` が必要です。
OIDC を使う場合は issuer、client ID、callback URL、最初の owner にする subject が
同じ設定になっているか確認します。Secret の値そのものはログや Issue に貼らないで
ください。

### Apps 画面に Yurucommu が表示されない

Takosumi の Apply が成功していても、`http.request@1` の `resource_uri`、
`launch_url`、v2 `interfaces` 宣言から compile された UI surface、開く binding
権限のいずれかが未解決ならリンクは表示されません。Output 単独の fallback や
クラウド内部のリソース ID から URL を作らず、Interface と Output を確認します。

### プッシュ通知が届かない

ブラウザ側で通知を有効にしたか、Gateway URL と公開 VAPID 鍵を組で設定したかを
確認します。Gateway が認証を求める場合は、Worker に token が Secret として
渡っているかも確認してください。Web Push には HTTPS が必要です。

### 外部サーバーへの配送が進まない

配送 Queue を処理する Worker と、失敗した処理を退避する Queue を確認します。
失敗を手動で無限に再試行せず、対象の配送、最終エラー、再試行回数を確認してから
復旧してください。

リポジトリ管理者が Worker を公開するときは、唯一の入口である
`bun run deploy -- yurucommu-worker` を使います。この処理は Worker コードだけを
更新し、データベースには触れません。必要条件は `bun run deploy -- --contract`
で副作用なしに確認できます。

## リポジトリ内の案内

- [`src/`](src/) — Web アプリ
- [`scripts/dev-mock-server.ts`](scripts/dev-mock-server.ts) — ローカル用モック API
- [`scripts/build-yurucommu-worker.ts`](scripts/build-yurucommu-worker.ts) — Worker のビルド
- [`deploy/takoform/`](deploy/takoform/) — Takosumi などの管理ホスト向け定義
- [`main.tf`](main.tf) — Cloudflare セルフホスト用 OpenTofu モジュール
- [`site/`](site/) — `yurucommu.com` の静的サイト、ヘルプ、仕様
- [`site/DEPLOY.md`](site/DEPLOY.md) — Web サイトを公開するときの手順
