// AIコンシェルジュ（Phase 4）
// `/質問` で聞かれたことに、家族のカレンダーと保存済みのおたよりをもとに OpenAI が答える。

import type { Env, Member } from './types';
import { listMembers } from './db';
import { isSubCalendarId, listGoogleItemsBetween, type RangeItem } from './google';
import { fetchIcs, icsItemsFromParsed, parseIcs } from './ics';
import { addDays, dayRange, formatDayLabel, formatHM, todayYMD, ymdString, type YMD } from './time';

/** カレンダーを何日先まで見るか */
const CALENDAR_DAYS = 14;
/** 回答の材料に入れるおたより：新しい順に最大件数と、全文の合計文字数 */
const MAX_OTAYORI = 20;
const MAX_OTAYORI_CHARS = 15000;
/** 1件のおたよりの全文を入れる上限（超えた分は省略） */
const MAX_CHARS_PER_OTAYORI = 3000;
/** 続けて質問したとき、前のやり取りを何件・何分前まで踏まえるか */
const HISTORY_COUNT = 3;
const HISTORY_MINUTES = 30;
/** 1人1日の質問回数の上限 */
export const DAILY_LIMIT_PER_USER = 30;
/** 月の利用額がこの割合を超えたら、回答の最後に知らせる */
const WARN_RATIO = 0.8;

export class ConciergeLimitError extends Error {}

// ───────────── 利用額 ─────────────

/** 今月（日本時間）の OpenAI 利用額（ドル）。おたよりOCR・AIコンシェルジュ・請求書・医療費の読み取りの合計 */
export async function monthlyCostUsd(env: Env): Promise<number> {
  const since = "datetime(created_at, '+9 hours') >= datetime('now', '+9 hours', 'start of month')";
  const results = await env.DB.batch(
    ['otayori_files', 'concierge_log', 'bills', 'medical_receipts'].map((table) =>
      env.DB.prepare(`SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM ${table} WHERE ${since}`),
    ),
  );
  const sums = results.map((r) => r.results[0] as { i: number; o: number });
  const i = sums.reduce((n, r) => n + r.i, 0);
  const o = sums.reduce((n, r) => n + r.o, 0);
  return (i * Number(env.OPENAI_PRICE_INPUT_PER_M) + o * Number(env.OPENAI_PRICE_OUTPUT_PER_M)) / 1_000_000;
}

async function countTodayByUser(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM concierge_log WHERE user_id = ? AND date(created_at, '+9 hours') = date('now', '+9 hours')",
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ───────────── 回答の材料 ─────────────

function rangeLine(it: RangeItem, tz: string): { sortKey: string; text: string } {
  const loc = it.location ? `（場所：${it.location.split('\n')[0]}）` : '';
  const cal = it.calendar ? `［${it.calendar}］` : '';
  if (it.allDay && it.startDate) {
    const s = it.startDate;
    const lastDay = it.endDate && it.endDate > s ? ymdString(addDays(parseYmd(it.endDate), -1)) : s;
    const label = lastDay === s ? formatDayLabel(parseYmd(s)) : `${formatDayLabel(parseYmd(s))}〜${formatDayLabel(parseYmd(lastDay))}`;
    return { sortKey: `${s} 00:00`, text: `- ${label} 終日 ${it.title}${cal}${loc}` };
  }
  const day = todayYMD(tz, it.start!);
  return {
    sortKey: `${ymdString(day)} ${formatHM(it.start!, tz)}`,
    text: `- ${formatDayLabel(day)} ${formatHM(it.start!, tz)}〜${formatHM(it.end!, tz)} ${it.title}${cal}${loc}`,
  };
}

function parseYmd(s: string): YMD {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** 1人分の、今日から CALENDAR_DAYS 日間の予定 */
async function memberCalendarText(env: Env, member: Member, today: YMD): Promise<string> {
  const tz = env.TIMEZONE;
  const start = dayRange(today, tz).start;
  const end = dayRange(addDays(today, CALENDAR_DAYS - 1), tz).end;
  const lines: { sortKey: string; text: string }[] = [];
  const notes: string[] = [];

  await Promise.all(
    member.calendars.map(async (c) => {
      const label = member.calendars.length > 1 && (c.kind === 'ics' || isSubCalendarId(c.source)) ? c.label : undefined;
      try {
        if (c.kind === 'google') {
          for (const it of await listGoogleItemsBetween(env, c.source, start, end, tz)) lines.push(rangeLine({ ...it, calendar: label }, tz));
        } else {
          const parsed = parseIcs(await fetchIcs(c.source));
          for (let i = 0; i < CALENDAR_DAYS; i++) {
            const day = addDays(today, i);
            for (const it of icsItemsFromParsed(parsed, day, tz)) {
              lines.push(rangeLine({ ...it, calendar: label, startDate: it.allDay ? ymdString(day) : undefined }, tz));
            }
          }
        }
      } catch (e) {
        console.error('concierge calendar failed', member.user_id, c.id, e);
        notes.push(`（${c.label} の予定は取得できませんでした）`);
      }
    }),
  );

  const unique = [...new Map(lines.map((l) => [l.text, l])).values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return [`### ${member.display_name}`, ...(unique.length ? unique.map((l) => l.text) : ['- 予定なし']), ...notes].join('\n');
}

async function calendarContext(env: Env, members: Member[], today: YMD): Promise<string> {
  if (members.length === 0) return '（カレンダーを登録している家族はいません）';
  const parts = await Promise.all(members.map((m) => memberCalendarText(env, m, today)));
  return parts.join('\n\n');
}

interface OtayoriRow {
  title: string;
  ocr_text: string;
  drive_name: string;
  drive_file_id: string;
  thread_id: string;
  message_id: string;
}

/** 回答に添える出典（おたより） */
export interface OtayoriSource {
  title: string;
  posted: string;
  threadUrl: string;
  driveUrl: string;
}

/** おたよりを［番号］付きで材料にする。番号は回答の sources で使う */
async function otayoriContext(env: Env): Promise<{ text: string; rows: OtayoriRow[] }> {
  const { results } = await env.DB.prepare(
    `SELECT title, ocr_text, drive_name, drive_file_id, thread_id, message_id FROM otayori_files
     WHERE status = 'done' AND ocr_text IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(MAX_OTAYORI)
    .all<OtayoriRow>();
  if (results.length === 0) return { text: '（保存されたおたよりはまだありません）', rows: [] };

  let total = 0;
  const docs = results.map((r, i) => {
    const head = `### ［${i + 1}］${r.title}（${postedLabel(r.drive_name)}投稿）`;
    const room = MAX_OTAYORI_CHARS - total;
    if (room <= 200) return `${head}\n（全文は省略）`;
    const body = r.ocr_text.slice(0, Math.min(MAX_CHARS_PER_OTAYORI, room));
    total += body.length;
    return `${head}\n${body}${body.length < r.ocr_text.length ? '\n（以下省略）' : ''}`;
  });
  return { text: docs.join('\n\n'), rows: results };
}

/** ファイル名の先頭 yyyymmdd から「9/24」を作る */
function postedLabel(driveName: string): string {
  const m = driveName?.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}` : '';
}

function toSource(env: Env, r: OtayoriRow): OtayoriSource {
  return {
    title: r.title,
    posted: postedLabel(r.drive_name),
    threadUrl: `https://discord.com/channels/${env.GUILD_ID}/${r.thread_id}/${r.message_id}`,
    driveUrl: `https://drive.google.com/file/d/${r.drive_file_id}/view`,
  };
}

async function historyContext(env: Env, userId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT question, answer FROM concierge_log
     WHERE user_id = ? AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT ?`,
  )
    .bind(userId, `-${HISTORY_MINUTES} minutes`, HISTORY_COUNT)
    .all<{ question: string; answer: string }>();
  return results.reverse().flatMap((r) => [
    { role: 'user' as const, content: r.question },
    { role: 'assistant' as const, content: r.answer },
  ]);
}

function instructions(today: YMD, nowHM: string, asker: { id: string; name: string }, members: Member[]): string {
  const dates = Array.from({ length: 21 }, (_, i) => {
    const d = addDays(today, i);
    return `${ymdString(d)} = ${formatDayLabel(d)}${i === 0 ? '（今日）' : i === 1 ? '（明日）' : ''}`;
  }).join('\n');
  const memberList = members.length ? members.map((m) => `- ID「${m.user_id}」：${m.display_name}`).join('\n') : '（なし）';

  return `あなたは、ある家族の Discord サーバーで働く「AIコンシェルジュ」です。家族からの質問に、日本語でやさしく、簡潔に答えます。

# 前提
- 今日は ${formatDayLabel(today)}（${today.y}年）、現在 ${nowHM}（日本時間）です。
- 質問しているのは「${asker.name}」さん（ID「${asker.id}」）です。
- 下の「家族の予定」と「保存されたおたより」は、この家族の実際のデータです。

# 日付の早見表
${dates}

# カレンダーを登録している家族
${memberList}

# 回答の形式（JSON で返す）
## kind = "schedule"（予定の一覧を求める質問）
- 「予定を教えて」「明日の予定は？」「来週どうなってる？」「〇〇さんの今週の予定」のように、ある期間の予定の一覧を求める質問。
- start_date と end_date に期間（YYYY-MM-DD。1日だけなら同じ日。最大14日間）を入れる。「来週」は次の月曜〜日曜、「今週」は今日〜今週の日曜、「週末」は次の土曜〜日曜。
- member_ids：「誰の」予定か指定があるときだけ、その人の ID を入れる（「私の」「自分の」は質問者）。**指定がなければ空（＝全員）**。
- answer：一覧の前に添える一言だけを書く（例：「来週（9/28〜10/4）の家族の予定です。」）。予定の中身は書かない（Bot が一覧を表示する）。
- sources は空。

## kind = "answer"（それ以外）
- 特定の予定が「いつ」か、おたよりの内容、一般的な質問など。start_date・end_date は空文字、member_ids は空。
- answer に回答を書く。予定やおたよりに関する質問は、必ず下のデータにもとづいて答え、データにないことは推測で断定せず「おたより・予定には見当たりません」と伝える。
- **予定の日時を聞かれたら（「運動会はいつ？」「次の歯医者は？」など）、必ず search_calendar でカレンダーを検索する**。下の「家族の予定」は14日分しかないため、そこに無くても検索する。**期間の指定がない質問では to_date を空にして1年先まで探す**。「次の」は今日以降で一番近いもの、「前回の」は今日より前で一番近いもの。
- カレンダーとおたよりの両方に情報があれば両方を使う。カレンダーの情報を使ったときは、誰の予定かがわかるように書く。両者の日付が食い違う場合は、両方を示してそのことを伝える。カレンダーで答えられたときは、「おたよりには見当たりません」のような一文は書かない（逆も同じ）。
- 日付は「9/25（金）」のように曜日つきで書く。持ち物・締め切り・時刻・金額は正確に書き写す。
- 一般的な質問（料理、調べもの、子育ての相談など）には、一般的な知識で答えてよい。
- Discord で読みやすいよう、長くても 10 行程度にまとめ、必要なら箇条書きを使う。見出し（#）は使わない。
- sources：根拠にしたおたよりの番号（「［1］」なら 1）。使っていなければ空。**answer の中に「根拠」「出典」の行は書かない**（Bot がリンク付きで添える）。`;
}

/** AI にカレンダー検索を何回まで使わせるか */
const MAX_TOOL_ROUNDS = 2;
/** 検索の既定の範囲（今日から何日先まで）と、iCal を調べる最大日数（iCal は1日ずつ調べるため短めに） */
const SEARCH_DEFAULT_DAYS = 365;
const SEARCH_ICS_MAX_DAYS = 120;
const SEARCH_MAX_RESULTS = 30;

const TOOLS = [
  {
    type: 'function',
    name: 'search_calendar',
    description:
      '家族のカレンダーから、キーワードに一致する予定を探す。「運動会はいつ？」「次の歯医者は？」「前回の美容院はいつ？」のように予定の日時を聞かれたときは必ず使う（上の「家族の予定」は14日分しかないため）。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '予定名に含まれそうな言葉（例：運動会、歯医者）。1語が望ましい' },
        from_date: { type: 'string', description: '探し始める日（YYYY-MM-DD）。通常は空（今日から）。「前回の」など過去を探すときだけ過去の日付（例：1年前）' },
        to_date: { type: 'string', description: '探し終える日（YYYY-MM-DD）。通常は空（1年後まで）。質問に期間の指定（「今月の」など）があるときだけ入れる' },
        member_ids: { type: 'array', items: { type: 'string' }, description: '対象の人の ID。空なら全員' },
      },
      required: ['keyword', 'from_date', 'to_date', 'member_ids'],
      additionalProperties: false,
    },
  },
];

/** search_calendar の実行。見つかった予定を「- 名前：日時 予定名」の形で返す */
async function searchCalendar(
  env: Env,
  members: Member[],
  args: { keyword?: string; from_date?: string; to_date?: string; member_ids?: string[] },
  today: YMD,
): Promise<string> {
  const keyword = (args.keyword ?? '').trim();
  if (!keyword) return 'キーワードが空です。';
  const result = await searchCalendarOnce(env, members, { ...args, keyword }, today);
  // 狭い期間で見つからなかったときは、今日から1年先まで広げて探し直す（AI が期間を短く指定しすぎる場合の対策）
  const first = toYmd(args.from_date ?? '') ?? today;
  const last = toYmd(args.to_date ?? '');
  const narrow = last && ymdString(last) < ymdString(addDays(first, SEARCH_DEFAULT_DAYS - 1));
  if (result.count === 0 && narrow && ymdString(first) >= ymdString(today)) {
    const wider = await searchCalendarOnce(env, members, { ...args, keyword, to_date: '' }, today);
    return `${result.text}\n\n期間を1年先まで広げて探し直しました：\n${wider.text}`;
  }
  return result.text;
}

async function searchCalendarOnce(
  env: Env,
  members: Member[],
  args: { keyword: string; from_date?: string; to_date?: string; member_ids?: string[] },
  today: YMD,
): Promise<{ text: string; count: number }> {
  const tz = env.TIMEZONE;
  const keyword = args.keyword;
  const first = toYmd(args.from_date ?? '') ?? today;
  let last = toYmd(args.to_date ?? '') ?? addDays(first, SEARCH_DEFAULT_DAYS);
  if (ymdString(last) < ymdString(first)) last = addDays(first, SEARCH_DEFAULT_DAYS);
  const targets = members.filter((m) => args.member_ids?.includes(m.user_id));
  const who = targets.length ? targets : members;
  const start = dayRange(first, tz).start;
  const end = dayRange(last, tz).end;
  const matches = (it: RangeItem) => it.title.includes(keyword) || (it.location ?? '').includes(keyword);

  const found: { sortKey: string; text: string }[] = [];
  const notes: string[] = [];
  await Promise.all(
    who.flatMap((m) =>
      m.calendars.map(async (c) => {
        const label = m.calendars.length > 1 && (c.kind === 'ics' || isSubCalendarId(c.source)) ? c.label : undefined;
        try {
          let items: RangeItem[];
          if (c.kind === 'google') {
            // Google の検索で見つからなければ、期間内の予定から文字で探す（日本語の部分一致の取りこぼし対策）
            items = await listGoogleItemsBetween(env, c.source, start, end, tz, keyword);
            if (items.length === 0) items = (await listGoogleItemsBetween(env, c.source, start, end, tz)).filter(matches);
          } else {
            const parsed = parseIcs(await fetchIcs(c.source));
            items = [];
            for (let i = 0, d = first; i < SEARCH_ICS_MAX_DAYS && ymdString(d) <= ymdString(last); i++, d = addDays(d, 1)) {
              for (const it of icsItemsFromParsed(parsed, d, tz)) if (matches(it)) items.push({ ...it, startDate: it.allDay ? ymdString(d) : undefined });
            }
          }
          for (const it of items) {
            const line = rangeLine({ ...it, calendar: label }, tz);
            found.push({ sortKey: line.sortKey, text: line.text.replace(/^- /, `- ${m.display_name}：`) });
          }
        } catch (e) {
          console.error('search_calendar failed', m.user_id, c.id, e);
          notes.push(`（${m.display_name}の「${c.label}」は検索できませんでした）`);
        }
      }),
    ),
  );

  const unique = [...new Map(found.map((f) => [f.text, f])).values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const range = `${formatDayLabel(first)}〜${formatDayLabel(last)}`;
  const head = `「${keyword}」の検索結果（${range}、対象：${who.map((m) => m.display_name).join('、') || 'なし'}）`;
  if (unique.length === 0) return { text: `${head}\n見つかりませんでした。${notes.join('')}`, count: 0 };
  const shown = unique.slice(0, SEARCH_MAX_RESULTS).map((f) => f.text);
  const more = unique.length > SEARCH_MAX_RESULTS ? `\n…ほか${unique.length - SEARCH_MAX_RESULTS}件` : '';
  return { text: `${head}\n${shown.join('\n')}${more}${notes.length ? '\n' + notes.join('') : ''}`, count: unique.length };
}

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['schedule', 'answer'] },
    start_date: { type: 'string' },
    end_date: { type: 'string' },
    member_ids: { type: 'array', items: { type: 'string' } },
    answer: { type: 'string' },
    sources: { type: 'array', items: { type: 'integer' } },
  },
  required: ['kind', 'start_date', 'end_date', 'member_ids', 'answer', 'sources'],
  additionalProperties: false,
};

// ───────────── 本体 ─────────────

export type ConciergeAnswer =
  | { kind: 'schedule'; intro: string; days: YMD[]; members: Member[]; warning?: string }
  | { kind: 'answer'; answer: string; sources: OtayoriSource[]; warning?: string };

function toYmd(s: string): YMD | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ymd = { y: +m[1], m: +m[2], d: +m[3] };
  return ymdString(ymd) === s ? ymd : null;
}

/** AI が返した期間を、正しい日付・最大 CALENDAR_DAYS 日に整える */
function daysBetween(start: string, end: string, today: YMD): YMD[] {
  let first = toYmd(start) ?? today;
  let last = toYmd(end) ?? first;
  if (ymdString(last) < ymdString(first)) [first, last] = [last, first];
  const days: YMD[] = [];
  for (let d = first; ymdString(d) <= ymdString(last) && days.length < CALENDAR_DAYS; d = addDays(d, 1)) days.push(d);
  return days;
}

export async function askConcierge(env: Env, user: { id: string; name: string }, question: string): Promise<ConciergeAnswer> {
  if ((await countTodayByUser(env, user.id)) >= DAILY_LIMIT_PER_USER) {
    throw new ConciergeLimitError(`今日の質問回数の上限（${DAILY_LIMIT_PER_USER}回）に達しました。明日またどうぞ。`);
  }
  const budget = Number(env.CONCIERGE_MONTHLY_BUDGET_USD);
  const spent = await monthlyCostUsd(env);
  if (spent >= budget) {
    throw new ConciergeLimitError(`今月の AI の利用額が上限（${budget}ドル）に達したため、来月まで質問を受け付けられません。`);
  }

  const tz = env.TIMEZONE;
  const now = new Date();
  const today = todayYMD(tz, now);
  const members = await listMembers(env);
  const [calendar, otayori, history] = await Promise.all([calendarContext(env, members, today), otayoriContext(env), historyContext(env, user.id)]);

  const data = `# 家族の予定（今日から${CALENDAR_DAYS}日間）\n${calendar}\n\n# 保存されたおたより（新しい順）\n${otayori.text}`;
  const baseBody: Record<string, unknown> = {
    model: env.OPENAI_MODEL,
    instructions: `${instructions(today, formatHM(now, tz), user, members)}\n\n${data}`,
    text: { format: { type: 'json_schema', name: 'concierge', strict: true, schema: SCHEMA } },
    tools: TOOLS,
    max_output_tokens: 4000,
    store: false,
    // 保存しない設定のまま、ツールの結果を渡して続きを考えさせるために必要
    include: ['reasoning.encrypted_content'],
  };
  if (env.CONCIERGE_REASONING_EFFORT) baseBody.reasoning = { effort: env.CONCIERGE_REASONING_EFFORT };

  // AI がカレンダー検索を使ったら、Bot が検索して結果を返し、続きを答えさせる（最大 MAX_TOOL_ROUNDS 回）
  let input: unknown[] = [...history, { role: 'user', content: question }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let raw: string | undefined;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, input, ...(round === MAX_TOOL_ROUNDS ? { tool_choice: 'none' } : {}) }),
    });
    const json = (await res.json()) as {
      status?: string;
      error?: { message: string };
      output?: { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${json.error?.message ?? 'unknown error'}`);
    usage.input_tokens += json.usage?.input_tokens ?? 0;
    usage.output_tokens += json.usage?.output_tokens ?? 0;

    const calls = (json.output ?? []).filter((o) => o.type === 'function_call');
    if (calls.length === 0) {
      raw = json.output
        ?.filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .find((c) => c.type === 'output_text')?.text;
      if (!raw) throw new Error(`OpenAI の応答に本文がありません（${json.status}）`);
      break;
    }
    const outputs = await Promise.all(
      calls.map(async (c) => ({
        type: 'function_call_output',
        call_id: c.call_id,
        output: c.name === 'search_calendar' ? await searchCalendar(env, members, JSON.parse(c.arguments ?? '{}'), today) : '未対応のツールです',
      })),
    );
    input = [...input, ...(json.output ?? []), ...outputs];
  }
  if (!raw) throw new Error('OpenAI から回答を得られませんでした');
  const out = JSON.parse(raw) as { kind: 'schedule' | 'answer'; start_date: string; end_date: string; member_ids: string[]; answer: string; sources: number[] };

  let result: ConciergeAnswer;
  let logged: string;
  if (out.kind === 'schedule') {
    const days = daysBetween(out.start_date, out.end_date, today);
    const chosen = members.filter((m) => out.member_ids.includes(m.user_id));
    const targets = chosen.length ? chosen : members;
    result = { kind: 'schedule', intro: out.answer.trim(), days, members: targets };
    logged = `${out.answer.trim()}（${formatDayLabel(days[0])}〜${formatDayLabel(days[days.length - 1])}の予定一覧を表示。対象：${chosen.length ? chosen.map((m) => m.display_name).join('、') : '全員'}）`;
  } else {
    const sources = [...new Set(out.sources)]
      .map((n) => otayori.rows[n - 1])
      .filter((r): r is OtayoriRow => !!r)
      .map((r) => toSource(env, r));
    result = { kind: 'answer', answer: out.answer.trim(), sources };
    logged = out.answer.trim();
  }

  await env.DB.prepare('INSERT INTO concierge_log (user_id, question, answer, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, question, logged, usage.input_tokens, usage.output_tokens)
    .run();

  const after = spent + (usage.input_tokens * Number(env.OPENAI_PRICE_INPUT_PER_M) + usage.output_tokens * Number(env.OPENAI_PRICE_OUTPUT_PER_M)) / 1_000_000;
  if (after >= budget * WARN_RATIO) {
    result.warning = `今月の AI の利用額が上限の${Math.round((after / budget) * 100)}%（${after.toFixed(2)}／${budget}ドル）になりました。`;
  }
  return result;
}
