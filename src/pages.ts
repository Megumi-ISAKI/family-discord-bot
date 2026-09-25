// Google の OAuth 同意画面（本番環境）に必要な「ホームページ」と「プライバシーポリシー」

const layout = (title: string, body: string) => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; line-height: 1.8; max-width: 720px; margin: 0 auto; padding: 32px 16px; color: #222; background: #fff; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2em; }
  a { color: #1a73e8; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #1b1b1b; } a { color: #8ab4f8; } }
</style>
</head>
<body>
${body}
</body>
</html>`;

export function homePage(): string {
  return layout(
    '家族Discord Bot',
    `<h1>家族Discord Bot</h1>
<p>家族専用の Discord サーバーで使う Bot です。家族それぞれの Google カレンダーの予定を、毎朝（今日の予定）と毎晩（明日の予定）Discord にまとめて投稿します。また、Discord から自分のカレンダーに予定を追加できます。</p>
<p>学校などのおたより（プリント）を Discord に投稿すると、文字を読み取って家族の Google ドライブに保存し、読み取った文章を Discord に返信します。</p>
<p>医療費の領収書を Discord に投稿すると、医療を受けた人・支払先・金額・支払日などを読み取って、確定申告（医療費控除）用に家族の Google スプレッドシートに年ごとに転記し、領収書の写真を家族の Google ドライブに保存します。</p>
<p>請求書や支払いの情報を Discord に投稿すると、金額・支払い先・期限などを読み取って家族のスプレッドシートに転記し、支払い状況を Discord とスプレッドシートのあいだで同期します。</p>
<p>この Bot は家族内だけで使うもので、一般には公開していません。</p>
<p><a href="/privacy">プライバシーポリシー</a></p>`,
  );
}

export function privacyPage(): string {
  return layout(
    'プライバシーポリシー｜家族Discord Bot',
    `<h1>プライバシーポリシー</h1>
<p>「家族Discord Bot」（以下「本Bot」）は、家族専用の Discord サーバーで予定を共有するためのツールです。本Botが扱う情報と、その取り扱いを次のとおり定めます。</p>

<h2>1. 取得する情報</h2>
<ul>
  <li>Discord のユーザーID と、サーバーでの表示名</li>
  <li>登録された Google カレンダーの ID（Gmail アドレス）、または iCal の URL</li>
  <li>共有されたカレンダーの予定（タイトル、日時、場所）</li>
  <li>おたより用のチャンネルに投稿された画像・PDF と、そこから読み取った文章</li>
  <li>医療費用のチャンネルに投稿された領収書の画像・PDF・本文と、そこから読み取った情報（医療を受けた人、病院・薬局、医療費の区分、金額、支払日）</li>
  <li>請求書・支払い用のチャンネルに投稿されたタイトル・本文・画像・PDF と、そこから読み取った支払い情報（支払い先、金額、期限、支払方法、振込先など）</li>
</ul>

<h2>2. 利用目的</h2>
<ul>
  <li>家族の Discord サーバーに、その日の予定を投稿するため</li>
  <li>Discord のコマンドで予定を表示したり、本人のカレンダーに予定を追加したりするため</li>
  <li>おたよりの文字を読み取り、家族の Google ドライブに保存して、Discord で検索できるようにするため</li>
  <li>請求の情報を家族の Google スプレッドシートに転記し、支払い漏れを防ぐため</li>
  <li>医療費の領収書を保存・集計し、確定申告（医療費控除）に使うため</li>
</ul>
<p>上記以外の目的には利用しません。広告、分析、第三者への提供・販売は行いません。</p>

<h2>3. 保存と管理</h2>
<ul>
  <li>Discord のユーザーID、表示名、カレンダーの ID（または URL）は、Cloudflare のデータベースに保存します。</li>
  <li>予定の内容は、表示・投稿のたびに Google カレンダーから読み込みます。本Botのデータベースには保存しません。</li>
  <li>Google へのアクセスに使う認証情報は、Cloudflare の暗号化された領域に保存し、管理者以外は参照できません。</li>
  <li>おたよりの画像・PDF は、文字の読み取りのために OpenAI の API に送信します（送信内容は OpenAI に保存しない設定で送ります）。読み取った文章は Cloudflare のデータベースと、家族の Google ドライブ（ファイルの説明欄）に保存します。</li>
  <li>請求書の画像・PDF・本文は、支払い情報の読み取りのために OpenAI の API に送信します（保存しない設定で送ります）。読み取った支払い情報は Cloudflare のデータベースと、家族の Google スプレッドシートに保存します。請求書の画像は Discord 以外には保存しません。</li>
  <li>医療費の領収書の画像・PDF・本文は、読み取りのために OpenAI の API に送信します（保存しない設定で送ります）。読み取った情報は Cloudflare のデータベースと家族の Google スプレッドシートに、領収書の画像は家族の Google ドライブに保存します。</li>
  <li>Bot が Google ドライブ・スプレッドシートで扱うのは、おたよりの保存と保存先フォルダの確認・作成、指定された請求管理のスプレッドシートの読み書き、および指定されたフォルダでの医療費のシート・年別フォルダの作成と読み書きだけです。</li>
</ul>

<h2>4. Google ユーザーデータの取り扱い</h2>
<p>本Botが Google API から受け取った情報の利用と他のアプリへの転送は、<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>（限定使用の要件を含む）に従います。</p>

<h2>5. 登録の解除とデータの削除</h2>
<ul>
  <li>Discord で <code>/カレンダー解除</code> を実行すると、本Botのデータベースから登録情報を削除します。</li>
  <li>Google カレンダーの共有設定から共有を外すと、本Botはそのカレンダーを読み取れなくなります。</li>
</ul>

<h2>6. お問い合わせ</h2>
<p>家族の Discord サーバーの管理者までご連絡ください。</p>

<p>制定日：2026年9月24日（おたより機能の追加に伴い同日改定、請求書・支払い管理と医療費の領収書の追加に伴い2026年9月25日改定）</p>
<p><a href="/">ホームに戻る</a></p>`,
  );
}
