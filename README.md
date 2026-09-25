# 家族専用 Discord Bot（family-discord-bot）

家族専用の Discord サーバー向けに作った Bot です。Cloudflare Workers 上で動くため、専用のサーバーを用意する必要がなく、無料枠〜低コストで運用できます。

もともとは自分の家族のために作ったものですが、同じような仕組みを作ってみたい人の参考になればと、コードを公開しています。制作の経緯や設計判断の背景は note の連載にまとめています（リンクは後日追記）。

**家族用の Google アカウントを、そのまま Bot として使います。** 家族はカレンダーをこのアカウントに共有するだけで登録できます。

## できること

| コマンド・機能 | 内容 |
|---|---|
| `/カレンダー登録` | 家族アカウントに共有されているカレンダーがメニューに出るので、自分のものを選びます（メイン以外のカレンダーも複数選べます）。`アドレス:` にカレンダーIDか iCal URL を入れて登録することもできます |
| `/カレンダー解除` | 登録したカレンダーを選んで解除します（すべて解除すると自動投稿から外れます） |
| `/今日の予定 [メンバー] [日付]` | 予定を表示します（実行した本人にだけ表示） |
| `/予定追加 タイトル 日付 [開始] [終了] [場所] [カレンダー]` | 自分の Google カレンダーに予定を追加します |
| `/質問 内容 [自分だけ]` | AIコンシェルジュに質問します。家族の予定（14日分、それより先はカレンダー検索）と保存済みのおたよりをもとに答えます |
| おたより投稿用フォーラムへの投稿 | 5分おきに確認し、画像・PDFの文字を読み取ってドライブの年度別フォルダに保存、全文を返信し「保存済み」タグを付けます |
| 医療費（確定申告用）フォーラムへの投稿 | 5分おきに確認し、領収書から医療を受けた人・支払先・区分・金額・支払日を読み取り、国税庁の医療費集計フォームと同じ並びのシートに年ごとに転記、写真を年別フォルダに保存します |
| 請求書・支払いフォーラムへの投稿 | 5分おきに確認し、画像・タイトル・本文から支払い先・金額・期限を読み取って指定のスプレッドシートに転記。「支払済み」はDiscordのタグとシートの状態を双方向に同期します |
| 毎朝 7:00（日本時間） | 登録メンバー全員の**今日の予定**をチャンネルに投稿します |
| 毎晩 20:00（日本時間） | 登録メンバー全員の**明日の予定**をチャンネルに投稿します |

コマンドの返信は（`/質問` を除き）実行した本人にだけ表示されます。

## 仕組み

```
Discord ─(スラッシュコマンド)─▶ Cloudflare Workers ─▶ Google Calendar / Drive / Sheets API
                                   │   （家族アカウントとしてアクセス）
                                   ├─ D1（メンバー・カレンダー・各種処理状況の記録）
                                   ├─ Cron（7:00・20:00 の予定投稿）
                                   └─ Cron（5分おき ×3、時刻を2〜4分ずつずらして実行）
                                        → おたよりOCR／請求書の転記／医療費の転記
```

家族には、自分のカレンダーを家族アカウントに「共有」してもらいます。共有の権限によって、Bot ができることが変わります。

| 共有の権限 | 自動投稿 | `/予定追加` |
|---|---|---|
| 予定の変更 | 予定名まで表示 | ✅ |
| すべての予定の詳細を表示 | 予定名まで表示 | ❌ |
| 予定の表示（時間枠のみ、詳細は非表示） | 「予定あり」とだけ表示 | ❌ |
| iCal URL で登録 | 予定名まで表示 | ❌ |

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/index.ts` | 入口。Discordからのリクエスト受付と、すべての定期実行の振り分け |
| `src/commands.ts` | 各スラッシュコマンド・選択メニュー・入力候補の処理 |
| `src/db.ts` | メンバー・カレンダーの読み書き（D1） |
| `src/google.ts` | Googleカレンダーとのやり取り（認証、予定の取得・追加） |
| `src/ics.ts` | iCal URLからの予定の読み取り |
| `src/schedule.ts` | 予定の整形、Discord投稿用の埋め込みの作成 |
| `src/discord.ts` | Discordの署名検証、返信・Webhook投稿 |
| `src/time.ts` | 日付・時刻の解析とタイムゾーンの計算 |
| `src/pages.ts` | ホームページとプライバシーポリシー（Google OAuth 同意画面の本番化に必要） |
| `src/otayori.ts` / `src/openai.ts` / `src/drive.ts` | おたよりOCR（画像・PDFの読み取り、ドライブ保存） |
| `src/concierge.ts` | AIコンシェルジュ（`/質問`。カレンダー検索の関数呼び出しに対応） |
| `src/bills.ts` / `src/sheets.ts` | 請求書・支払い管理（スプレッドシートへの転記、支払い状況の同期） |
| `src/medical.ts` | 医療費の領収書（確定申告用。年ごとのシート・フォルダを自動作成） |
| `scripts/google-login.mjs` | 家族アカウントでログインし、トークンをCloudflareに登録する（初回のみ） |
| `scripts/register-commands.mjs` | スラッシュコマンドをDiscordに登録する |
| `schema.sql` | D1のテーブル定義（新規作成用） |
| `migrations/` | 途中から機能を足す場合に、運用中のデータベースへ適用するSQL |

---

## セットアップ（管理者が最初に1回だけ行う）

### 1. Google Cloud（家族アカウントで行う）

1. **家族アカウントで**ログインして [Google Cloud Console](https://console.cloud.google.com/) を開き、新しいプロジェクトを作成します
2. 「API とサービス」→「ライブラリ」で **Google Calendar API**・**Google Drive API**・**Google Sheets API** をそれぞれ検索して「有効にする」（Drive API はおたより・医療費の写真保存、Sheets API は請求書・医療費の転記に使います）
3. 「API とサービス」→「OAuth 同意画面」（「Google Auth Platform」と表示される場合もあります）
   - アプリ名：自由
   - ユーザーの種類：**外部**
   - サポートメール・連絡先：家族アカウントのアドレス
4. 「ブランディング」で、アプリ名・ユーザーサポートメール・デベロッパーの連絡先を入力して保存します
   - ⚠️ **アプリのロゴはアップロードしないでください**（Google の審査が必要になります）
   - 本番環境への切り替えには、ホームページとプライバシーポリシーの URL も必要です。これは Bot 自身が表示するので、**手順4のデプロイのあとで**設定します
5. 「クライアント」（または「認証情報」）→「クライアントを作成」→ アプリケーションの種類 **「デスクトップ アプリ」**
   - 表示された **クライアント ID** と **クライアント シークレット** を控えます

### 2. Discord（Bot アプリと Webhook を作る）

1. [Discord Developer Portal](https://discord.com/developers/applications) →「New Application」
2. 「General Information」で次の2つを控えます：**APPLICATION ID**、**PUBLIC KEY**
3. 「Bot」→「Reset Token」で **Bot Token** を控えます（コマンド登録・各機能のフォーラム確認に使います）
4. 「Bot」→「Privileged Gateway Intents」で **MESSAGE CONTENT INTENT** をオンにします（おたより・請求書・医療費のフォーラムを読むために必要）
5. Developer Portal の「OAuth2」→「URL Generator」で、SCOPES に **bot** と **applications.commands** を、BOT PERMISSIONS に次を選び、生成されたURLをブラウザで開いてサーバーに追加します
   - チャンネルを見る（View Channels）
   - メッセージを送信する（Send Messages）
   - スレッドでメッセージを送信する（Send Messages in Threads）
   - スレッドを管理する（Manage Threads）※おたより・請求書・医療費の「処理済み」タグを付けるために必要
   - メッセージ履歴を読む（Read Message History）
6. Discord の「設定」→「詳細設定」で「開発者モード」を ON にし、サーバー名を右クリック →「サーバーIDをコピー」します
7. 予定を投稿したいチャンネルの ⚙️ →「連携サービス」→「ウェブフック」→「新しいウェブフック」→ **URL をコピー** します
8. おたより・請求書・医療費用に、それぞれフォーラムチャンネルを作成し、チャンネルIDを控えます（各チャンネルを右クリック →「IDをコピー」）
   - ⚠️ フォーラムチャンネルを作るには、サーバーの**コミュニティ機能**が有効になっている必要があります。無効なままだと、チャンネル作成時の種類の選択肢に「フォーラム」が出てきません。サーバー設定 →「コミュニティ」からオンにしてください
9. **各フォーラムに、Botが使うタグを作成します。**Botは名前に決まった文字を含むタグを探すので、次の文字を含む名前で作ってください（絵文字を付けるなど、装飾は自由です）。タグが無くても投稿の読み取り自体は動きますが、該当の処理（タグ付け・同期・家族の判定）だけが無言でスキップされます

   | フォーラム | 作るタグ |
   |---|---|
   | おたより | 「**保存済み**」を含む名前のタグを1つ（例：`✅ 保存済み`） |
   | 請求書・支払い | 「**転記**」を含む名前のタグと、「**支払済**」を含む名前のタグの2つ（例：`転記`、`支払済み`） |
   | 医療費 | 「**転記済**」を含む名前のタグを1つ（例：`転記済`）。**加えて、医療費を使う家族の人数分、名前そのものをタグ名にしたタグを作ります**（例：`愛`、`一朗`）。⚠️ このフォーラムでは、「転記済」「保存」という文字を含まないタグがすべて「家族の名前」として扱われます（`/質問`の対象者選びとは別の仕組みです）。名前タグを作り忘れると、医療を受けた人の判定ができません |

### 3. 設定ファイルを埋める

`wrangler.toml.example` を `wrangler.toml` にコピーして、値を埋めます。

```bash
cp wrangler.toml.example wrangler.toml
```

| 変数 | 埋める値 |
|---|---|
| `GUILD_ID` | 手順2-6のサーバーID |
| `DISCORD_APPLICATION_ID` | 手順2-2のアプリケーションID |
| `BOT_GOOGLE_EMAIL` | 家族アカウントの Gmail アドレス |
| `OTAYORI_CHANNEL_ID` | おたより用フォーラムのチャンネルID（使わない場合は空のままでよい） |
| `OTAYORI_DRIVE_FOLDER_ID` | おたよりの保存先フォルダのID（フォルダのURLの `/folders/` の後ろ） |
| `BILLS_CHANNEL_ID` / `BILLS_SHEET_ID` | 請求書用フォーラムのチャンネルID／転記先スプレッドシートのID（スプレッドシートのURLの `/d/` と `/edit` の間。使わない場合は空のままでよい） |
| `MEDICAL_CHANNEL_ID` / `MEDICAL_FOLDER_ID` | 医療費用フォーラムのチャンネルID／シートと写真を保存するフォルダのID（フォルダのURLの `/folders/` の後ろ。使わない場合は空のままでよい） |
| `database_id` | 手順4で `wrangler d1 create` を実行すると表示される |

使わない機能がある場合は、該当するチャンネルIDを設定しなければその機能は動きません（Cronは動きますが、対象チャンネルが無いだけです）。不要な機能のCronを`wrangler.toml`の`crons`から削除しても構いません。

⚠️ **`OTAYORI_DRIVE_FOLDER_ID`・`MEDICAL_FOLDER_ID`のフォルダと、`BILLS_SHEET_ID`のスプレッドシートは、Botが自動で作るものではありません。** 先にGoogleドライブ側で作成し、**家族アカウントが編集できる場所**（家族アカウント自身のマイドライブに作るか、家族アカウントに編集権限で共有する）に置いてください。ここが家族アカウントの権限で開けないと、該当機能は403エラーで失敗します。

`.dev.vars.example` をコピーして `.dev.vars` を作り、中身を埋めます（このファイルは他人に渡さないでください。`.gitignore` 済みです）。

```bash
cp .dev.vars.example .dev.vars
```

### 4. Cloudflare（Bot を動かす）

```bash
npm install
npx wrangler login
npx wrangler d1 create family-discord-bot
```

表示された `database_id` を `wrangler.toml` に貼り付けてから、データベースを初期化して一度デプロイします。

```bash
npm run db:init
npm run deploy
```

表示された `https://〜.workers.dev` の URL を控えておきます。次に、秘密の値を登録します。

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put OPENAI_API_KEY
```

（`DISCORD_BOT_TOKEN` は手順2-3で控えたトークンです。おたより・請求書・医療費のフォーラムを読みに行くのに使うほか、`.dev.vars`側の同じ値を次の手順5の`npm run register-commands`でも使うので、フォーラム機能を使わない場合も本物の値を設定してください）

続いて、Google の OAuth 同意画面を本番環境に切り替えます（家族アカウントで操作）。

1. デプロイで表示された URL をブラウザで開き、Bot のホームページが表示されることを確認します
2. Google Cloud の「Google Auth Platform」→「ブランディング」に次のように入力して保存します
   - アプリケーションのホームページ：`https://〜.workers.dev/`
   - プライバシー ポリシーのリンク：`https://〜.workers.dev/privacy`
   - 承認済みドメイン：`〇〇.workers.dev`
3. 「対象」→「アプリを公開」→ **本番環境** に切り替えます
   - ⚠️ 「テスト」のままだと、7日ごとにログインのやり直しが必要になります
   - 自分たちだけで使うアプリなので、Google の審査は受けなくて構いません（ログイン時に警告が出るだけです）

最後に、家族アカウントで Google にログインして Bot に権限を許可します。

```bash
npm run google-login
```

- ブラウザが開くので、**家族アカウント**でログインします
- 「このアプリは Google で確認されていません」と出たら、「詳細」→「（アプリ名）に移動」で進みます
- 許可すると、トークンが自動で Cloudflare に登録されます（トークンは画面に表示されません）

### 5. Discord と Workers をつなぐ

1. Developer Portal の「General Information」→ **INTERACTIONS ENDPOINT URL** に、手順4の `https://〜.workers.dev` を貼り付けて保存します
2. スラッシュコマンドを登録します

```bash
npm run register-commands
```

これで準備は完了です。

---

## 使わない機能を削る場合

このBotは筆者の家族の使い方に合わせて、カレンダー連携・おたよりOCR・AIコンシェルジュ・請求書管理・医療費管理をひとつにまとめています。必要な機能だけを使いたい場合は、

- `wrangler.toml` の `crons` から不要な行を削除する
- 該当するチャンネルIDの環境変数を設定しない（機能が動かなくなります）
- `src/index.ts` から該当する `poll〜` の呼び出しを削除する

といった形で、部分的に削ぎ落として使うこともできます。

⚠️ **Cloudflareの無料プランでは、1つのWorkerに設定できるCron Triggerは5個までです。** `wrangler.toml.example`はこの5個（予定投稿×2、おたより・請求書・医療費の確認×3）をすべて使い切っています。機能を減らさずに6個目のCron（新しい定期処理）を足したい場合は、上限に達するため、既存のCronのどれか1つの中で複数の処理をまとめて呼び出す形に書き換える必要があります。

## Bot を解除するとき

1. **アクセス権を取り消す**：家族アカウントで [Google アカウント → サードパーティ製のアプリとサービス](https://myaccount.google.com/connections) を開き、Bot のアプリを選んで「アクセス権を削除」を押します
2. **Bot 本体とデータを削除する**：`npx wrangler delete` と `npx wrangler d1 delete family-discord-bot`
3. **Discord 側を片付ける**：サーバー設定 →「連携サービス」で Bot アプリとウェブフックを削除します

## よくある変更・トラブル

- **投稿時刻を変える**：`wrangler.toml` の `crons` を変えて `npm run deploy` します。時刻は UTC で指定します
- **「アクセス許可が切れています」と出る**：`npm run google-login` をもう一度実行します
- **動作ログを見る**：`npx wrangler tail`

## データベースの更新（すでに運用中の場合）

`migrations/` のファイルを番号順に一度だけ実行します。新しく作る場合は `npm run db:init` だけで構いません。

```bash
npx wrangler d1 execute family-discord-bot --remote --file=migrations/0002_multi_calendar.sql
```

## ライセンス

[MIT License](./LICENSE)。自己責任でご自由にお使いください。動作の保証やサポートは行っていません。
