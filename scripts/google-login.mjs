// 家族アカウントで Google にログインし、Bot 用のリフレッシュトークンを取得する（最初に1回だけ）
// 実行: npm run google-login
//
// 取得したトークンは画面に表示せず、そのまま Cloudflare の秘密の値（GOOGLE_REFRESH_TOKEN）に登録する。

import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('.dev.vars に GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定してください');
  process.exit(1);
}

// カレンダーの読み書き ＋ おたよりの保存（家族アカウントのドライブ）
const SCOPE = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive';
const state = randomBytes(16).toString('hex');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

console.log('\nブラウザが開きます。**家族アカウント**でログインし、カレンダーとドライブへのアクセスを許可してください。');
console.log('（「Google で確認されていません」と出たら「詳細」→「〜に移動」で進めます）');
console.log('\n開かない場合は次の URL をブラウザに貼り付けてください:\n' + authUrl + '\n');
execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [authUrl], () => {});

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url, redirectUri);
    const done = (msg) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<p style="font:16px sans-serif;padding:2em">${msg}</p>`);
    };
    if (url.searchParams.get('state') !== state) return done('無効なリクエストです。');
    const err = url.searchParams.get('error');
    if (err) {
      done('許可されませんでした。ターミナルに戻ってください。');
      return reject(new Error(err));
    }
    done('✅ ログインできました。このタブを閉じてターミナルに戻ってください。');
    resolve(url.searchParams.get('code'));
  });
});
server.close();

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok || !tokens.refresh_token) {
  console.error('トークンを取得できませんでした:', tokens);
  process.exit(1);
}

// どのアカウントでログインしたかを確認する（メインカレンダーの ID = Gmail アドレス）
const primary = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', {
  headers: { authorization: `Bearer ${tokens.access_token}` },
}).then((r) => r.json());
console.log(`\nログインしたアカウント: ${primary.id}`);
console.log('→ wrangler.toml の BOT_GOOGLE_EMAIL がこのアドレスになっているか確認してください。\n');

console.log('Cloudflare に GOOGLE_REFRESH_TOKEN を登録します…');
const child = spawn('npx', ['wrangler', 'secret', 'put', 'GOOGLE_REFRESH_TOKEN'], {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: process.platform === 'win32',
});
child.stdin.end(tokens.refresh_token);
child.on('exit', (status) => {
  if (status === 0) console.log('\n✅ 完了しました。');
  else console.error('\n登録に失敗しました。先に npm run deploy を1回実行してから、もう一度お試しください。');
  process.exit(status ?? 1);
});
