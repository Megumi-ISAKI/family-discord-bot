// スラッシュコマンドを Discord サーバーに登録する（コマンド内容を変えたときも再実行）
// 実行: node --env-file=.dev.vars scripts/register-commands.mjs

const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN || !GUILD_ID) {
  console.error('.dev.vars に DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN / GUILD_ID を設定してください');
  process.exit(1);
}

const STRING = 3;
const USER = 6;
const BOOLEAN = 5;

const commands = [
  {
    name: '質問',
    description: 'AIコンシェルジュに質問します（家族の予定やおたよりをもとに答えます）',
    options: [
      { type: STRING, name: '内容', description: '例：来週の遠足の持ち物は？', required: true, max_length: 1000 },
      { type: BOOLEAN, name: '自分だけ', description: '回答を自分だけに表示する（省略するとチャンネルの全員に表示）', required: false },
    ],
  },
  {
    name: 'カレンダー登録',
    description: '自分のカレンダーを登録します（アドレスなしで実行するとメニューから選べます）',
    options: [
      { type: STRING, name: 'アドレス', description: 'カレンダーID（Gmail アドレスなど）、または iCal の URL', required: false },
    ],
  },
  {
    name: 'カレンダー解除',
    description: '自分のカレンダー登録を解除します',
  },
  {
    name: '今日の予定',
    description: '登録メンバーの予定を表示します（自分にだけ表示）',
    options: [
      { type: USER, name: 'メンバー', description: '特定のメンバーだけ表示', required: false },
      { type: STRING, name: '日付', description: '例：明日、9/25、2026-09-25（省略で今日）', required: false },
    ],
  },
  {
    name: '予定追加',
    description: '自分の Google カレンダーに予定を追加します',
    options: [
      { type: STRING, name: 'タイトル', description: '予定の名前', required: true },
      { type: STRING, name: '日付', description: '例：今日、明日、9/25、2026-09-25', required: true },
      { type: STRING, name: '開始', description: '例：15:00、15時半（省略で終日）', required: false },
      { type: STRING, name: '終了', description: '例：16:00（省略で開始の1時間後）', required: false },
      { type: STRING, name: '場所', description: '場所やURL', required: false },
      { type: STRING, name: 'カレンダー', description: '追加先のカレンダー（省略でメインカレンダー）', required: false, autocomplete: true },
    ],
  },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
  {
    method: 'PUT',
    headers: { authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  },
);
if (!res.ok) {
  console.error('登録に失敗しました', res.status, await res.text());
  process.exit(1);
}
console.log(`✅ ${commands.length} 個のコマンドを登録しました`);
