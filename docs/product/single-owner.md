# Yurucommu の1人用の所有モデル

Yurucommu は各自が自分用にデプロイして使うソフトウェアです。1つのインスタンスの
人間の所有者は1人であり、共用インスタンスへ複数の所有ユーザーを登録するサービスを
製品の目的にしません。この前提は Yurucommu に対するもので、Yurumeet の前提を
定義しません。

## 認証とデータの境界

| 主体 | 現行の境界 | 所有との関係 |
| --- | --- | --- |
| root owner | local actor の role=owner。設定されたパスワードで既存 owner へログイン | インスタンスを使う1人の所有者 |
| subaccount | role=member、ownerActorApId が root owner を指す。作成は owner のみ、切替は同じ root の範囲 | 同じ人の用途別プロフィール。別人の所有者登録ではない |
| 外部subjectの明示的な参加 | 共通Coreの許可リストは既定で空。許可された subject は root にひも付かない member として保存される | インスタンス owner ではなく、subaccount とも別。所有者の代わりに設定・プロフィール追加を行えない |
| remote actor | actor_cache に保存。通信だけでは local actor/session を作らない | 他のインスタンスの通信相手。ローカルの所有権限を持たない |
| community owner | community_members のスコープ内の権限 | インスタンス所有者を増やすものではない |

公開された投稿・プロフィールと、DM・限定公開の投稿・media は公開範囲に従います。
通信相手を local session や root owner に昇格させてアクセスを成立させません。
DB・ObjectBucket の運用責任と、投稿/アップロードの actor attribution は別の境界です。
外部参加者の存在だけで独立した所有ユーザーが登録されたと判断しません。

## 自分用の初回導入

デプロイする人が自分の認証情報、暗号化キー、session salt を用意します。
パスワード運用では owner がいなければ初回の成功ログインで作成し、以後は同じ owner を
使います。OIDC では owner にする subject の pin と callback を確認します。pin のない
初回取得の明示的な許可は、owner が同時に複数成立しない証明を代替しません。
既存インスタンスでは秘密値とデータを保持し、認証情報の更新やデータ移行は所有者の
手順として確認します。新たな共用ユーザー登録導線は導入手順に含めません。

## GAで必要な証拠

1. 空の実runtime storeへの自己導入で、成功ログインからownerがちょうど1人成立する。
2. 再ログイン、同時初回claim、プロフィール追加、外部subjectの参加でもroot ownerが
   増えず、追加所有者を作る要求が拒否される。
3. 用途別プロフィールの所属と切替が同じownerの範囲に限定される。
4. 実際の外部通信相手がlocal sessionや設定・所有権限を得ず、公開/限定公開の
   投稿・DM・mediaの境界を守ったまま通信できる。
5. 更新・復旧後も同じowner、所属、データ、秘密値の対応が保持される。

sourceで確認できるのは通常のowner/subaccount/member/remoteの区別です。
DM・mediaのnative artifact journeyは既存ownerと合成member sessionをseedするため、
初回導入や実際の外部参加の証拠にはしません。別の初回owner検証では、migrationのみを
適用した空のnative DBから、PBKDF2/初回tokenとbrowser cookie/mobile Bearerの
4条件で実際のパスワード認証APIを通し、1人のowner、再ログイン、同じownerの
memberプロフィール、cookieでの所属内切替を確認します。これはworkerd上のartifact
検証であり、公開環境への自己導入、ネイティブUI、OIDC、同時初回claim、実際の外部通信、
更新/復旧の証拠とは区別します。

公開Core 4.1.11のOIDC初回claimは
actor数の確認とowner insertが別操作で、pinのない異なるsubjectが競合して複数ownerに
なり得るsource上の不足があります。実環境での発生を確認したものではありません。
共通Coreの原子的なowner slot取得と、既存データへの対処は主担当へ提案し、公開contract
とconsumerを検証するまでこのGA条件は未達として扱います。
