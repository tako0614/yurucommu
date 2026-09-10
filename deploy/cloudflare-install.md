# Cloudflare ルートモジュールを Takosumi から導入する

ルートの `main.tf` は Worker と Cloudflare リソースを作成します。認証と新しい
D1 の初期化まで含めるには、次の設定が必要です。現時点では、初期設定なしの
ワンクリック導入ではありません。

## 認証と接続先

- API token は Connection の秘密値として保存します。`scopeHints`、manifest、
  Git、ログには入れません。
- account ID、workers.dev の subdomain、`enable_cloudflare_resources` と
  `enable_cloudflare_worker_script` は接続先の非機密な `moduleInputDefaults` で
  指定します。manifest にクラウドの操作権限を持たせません。
- 初期パスワードは `auth_password_hash` の機密入力です。現在の初回インストール
  経路では秘密値を保存できないため、作成フラグを false にした接続先で、未適用の
  Capsule を用意します。その後、サービス設定の
  `POST /api/v1/capsules/{id}/configuration-plans` で秘密値を保存し、作成フラグを
  true にした接続先を選び直します。元の設定行を書き換えるのではなく、設定変更を
  含む新しい Plan を確認します。空の認証で Apply しないでください。
- OIDC を使う場合は、クライアント登録、callback、所有者の識別子を別途正しく
  設定します。最初にログインした人を無条件に所有者にする設定には変更しません。

## DB 初期化の担当

[`cloudflare-install-config.patch.json`](cloudflare-install-config.patch.json)
は、運用者が内容を確認して選択する InstallConfig の設定例です。リポジトリから
自動採用される manifest ではなく、このファイルを置くだけでは何も実行されません。
既存の lifecycleActions を置き換える内容なので、他のアプリの共有設定に
そのまま適用しないでください。

運用者権限で変更可能な共有設定を明示的に選ぶか、独立した撮影用ホストの設定へ
この内容を組み込みます。Workspace 所有の設定やコンパイル済みの設定へ、PATCH で
実行権限を追加することはできません。対象を限定する `sourceSelector` はこの
ファイルに含まれないため、Git URL と module path をホスト側で別途固定します。

独立した導入用の base InstallConfig を、対象 Git URL・ルート module `.` と
結び付けてから利用します。すでにコンパイルされた不変の設定へ権限を後付けせず、
ホスト側の設定で、上記の post_apply と対応する policy を明示します。選択する
runner が `capsule.lifecycle.command.v1` を提供していることも確認します。
ホスト側にも、その post_apply を実行する release activator が必要です。

sourceBuild はクラウド認証情報なしで `bun install --frozen-lockfile` を実行します。
これにより、固定した Core パッケージの SQL と、初期化スクリプトの依存関係を
用意します。その後の post_apply だけが接続先の認証情報を受け取り、
`bun scripts/takosumi-release.ts --migrations-only` を実行します。
Worker を Wrangler で再デプロイする処理は呼び出しません。

DB 初期化に失敗すると、Apply Run と Capsule はエラーになります。ただし、先に
作成されたクラウド資源と、その StateVersion・Output は残る場合があります。
失敗した Plan を無条件に再実行せず、記録された状態と migration の履歴を確認し、
正式な post_apply 復旧手順、または確認済みの destroy を使います。
リソースだけ作成できたことを利用開始の成功とせず、migration の結果、ログイン、
投稿の保存と再読み込みを確認してください。既存 DB は新規導入と区別し、migration 履歴・バックアップ・
復旧手順を確認してから変更します。既存の本番 DB に
`wrangler d1 migrations apply` を無条件に実行しないでください。

## 検証状態

この設定は現在ローカルでの修正・契約検査段階です。公開リリースや本番環境への
適用、Takosumi からの新規導入の成功を示すものではありません。実際に使う際は、
修正版の正確な Git commit を同期し、Plan と適用結果をその commit に対応させて
記録します。
