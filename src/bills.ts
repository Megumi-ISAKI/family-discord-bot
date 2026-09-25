// 請求書・支払い管理（Phase 5）
// 5分おきに 💸-請求書・支払い（フォーラム）を確認し、
//  1) 新しい投稿の請求情報（画像・PDF・タイトル・本文）を読み取ってスプレッドシートに転記する
//  2) 「支払済み」を Discord のタグとシートの「状態」列のあいだで同期する（変えたほうに合わせる）

import type { Env } from './types';
import { botApi, type DiscordMessage, type DiscordThread } from './discord';
import { GoogleApiError, GoogleAuthError } from './google';
import { extractBill } from './openai';
import { supportedType } from './otayori';
import { STATUS_PAID, STATUS_UNPAID, appendBillRow, isPaidStatus, openBillSheet, readBillRows, rowUrl, setBillStatus, type SheetBillRow, type SheetInfo } from './sheets';
import { formatDayLabel, todayYMD, ymdString, type YMD } from './time';

/** 1回の実行で転記する最大件数・同期する最大件数（Workers 無料プランの外部通信 50 回に収めるため） */
const MAX_NEW_PER_RUN = 3;
const MAX_SYNC_PER_RUN = 10;
/** 1件の請求で読み取る添付ファイルの最大数と大きさ */
const MAX_FILES_PER_BILL = 4;
const MAX_BYTES = 20 * 1024 * 1024;
/** 失敗したときに自動でやり直す回数の上限 */
const MAX_ATTEMPTS = 3;
/** タグの名前（この文字を含むタグを探す） */
const TAG_TRANSCRIBED = '転記';
const TAG_PAID = '支払済';

interface BillRow {
  thread_id: string;
  status: string;
  attempts: number;
  paid: number;
  updated_at: string;
}

interface Tags {
  transcribed: string | null;
  paid: string | null;
}

const slash = (ymd: YMD) => ymdString(ymd).replace(/-/g, '/');

function parseYmd(s: string): YMD {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** 設定の問題（許可切れ・API が無効・シートの権限なし）なら true。直せば自動でやり直せるよう回数に数えない */
function isSetupProblem(e: unknown): boolean {
  return (
    e instanceof GoogleAuthError ||
    (e instanceof GoogleApiError && (e.status === 403 || e.status === 404) && /SERVICE_DISABLED|accessNotConfigured|insufficient|SCOPE|permission|not found/i.test(e.message))
  );
}

export async function pollBills(env: Env): Promise<void> {
  if (!/^[\w-]{20,}$/.test(env.BILLS_SHEET_ID)) {
    console.log('bills: BILLS_SHEET_ID が未設定のため、転記しません');
    return;
  }
  const token = env.DISCORD_BOT_TOKEN;

  // フォーラムのタグと投稿（開いているもの＋最近閉じたもの）
  const [forum, active, archived] = await Promise.all([
    botApi<{ available_tags?: { id: string; name: string }[] }>(token, `/channels/${env.BILLS_CHANNEL_ID}`),
    botApi<{ threads: DiscordThread[] }>(token, `/guilds/${env.GUILD_ID}/threads/active`),
    botApi<{ threads: DiscordThread[] }>(token, `/channels/${env.BILLS_CHANNEL_ID}/threads/archived/public?limit=100`),
  ]);
  const findTag = (name: string) => forum.available_tags?.find((t) => t.name.includes(name))?.id ?? null;
  const tags: Tags = { transcribed: findTag(TAG_TRANSCRIBED), paid: findTag(TAG_PAID) };
  const threads = new Map<string, DiscordThread>();
  for (const t of [...archived.threads, ...active.threads.filter((t) => t.parent_id === env.BILLS_CHANNEL_ID)]) threads.set(t.id, t);

  let sheet: SheetInfo;
  let rows: Map<string, SheetBillRow>;
  try {
    sheet = await openBillSheet(env);
    rows = new Map((await readBillRows(env, sheet)).map((r) => [r.threadId, r]));
  } catch (e) {
    console.error('bills: スプレッドシートを開けません', e);
    return;
  }

  const { results: known } = await env.DB.prepare('SELECT thread_id, status, attempts, paid, updated_at FROM bills').all<BillRow>();
  const bills = new Map(known.map((b) => [b.thread_id, b]));

  // 1) 新しい投稿（と、失敗したもののやり直し）を転記する
  const retryable = (b: BillRow) =>
    (b.status === 'error' || b.status === 'processing') && b.attempts < MAX_ATTEMPTS && Date.parse(b.updated_at.replace(' ', 'T') + 'Z') < Date.now() - 4 * 60_000;
  const todo = [...threads.values()]
    .filter((t) => !bills.has(t.id) || retryable(bills.get(t.id)!))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .slice(0, MAX_NEW_PER_RUN);
  for (const thread of todo) {
    await processBill(env, sheet, rows, thread, tags, bills.get(thread.id));
  }

  // 2) 支払済みの同期
  if (!tags.paid) {
    console.log(`bills: 「${TAG_PAID}」を含むタグが見つからないため、支払い状況の同期をしません`);
    return;
  }
  const done = known.filter((b) => b.status === 'done' && !todo.some((t) => t.id === b.thread_id));
  let changes = 0;
  const today = slash(todayYMD(env.TIMEZONE));
  for (const bill of done) {
    if (changes >= MAX_SYNC_PER_RUN) break;
    const thread = threads.get(bill.thread_id);
    const row = rows.get(bill.thread_id);
    const d = thread ? (thread.applied_tags ?? []).includes(tags.paid) : undefined;
    const s = row ? isPaidStatus(row.status) : undefined;
    if (d === undefined && s === undefined) continue;
    const prev = bill.paid === 1;

    // 両方わかるときは、前回から変わったほうに合わせる
    let target: boolean;
    if (d !== undefined && s !== undefined) target = s === d ? s : s !== prev ? s : d;
    else target = (s ?? d)!;

    try {
      // 状態が違う、または支払日が状態と合っていない（未払いなのに日付がある・支払い済なのに日付がない）ときに直す
      if (row && (s !== target || (!target && row.paidDate) || (target && !row.paidDate))) {
        await setBillStatus(env, sheet, row.row, target, row.paidDate || today);
        changes++;
      }
      if (thread && d !== target) {
        const current = thread.applied_tags ?? [];
        const next = target ? [...current, tags.paid] : current.filter((t) => t !== tags.paid);
        await botApi(token, `/channels/${thread.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ applied_tags: next.slice(0, 5), ...(thread.thread_metadata?.archived ? { archived: false } : {}) }),
        });
        changes++;
      }
      if (target !== prev) {
        await env.DB.prepare("UPDATE bills SET paid = ?, updated_at = datetime('now') WHERE thread_id = ?").bind(target ? 1 : 0, bill.thread_id).run();
      }
    } catch (e) {
      console.error('bills: 同期に失敗', bill.thread_id, e);
    }
  }
}

async function processBill(env: Env, sheet: SheetInfo, rows: Map<string, SheetBillRow>, thread: DiscordThread, tags: Tags, existing?: BillRow) {
  const token = env.DISCORD_BOT_TOKEN;
  const attempts = (existing?.attempts ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO bills (thread_id, status, attempts) VALUES (?, 'processing', ?)
     ON CONFLICT(thread_id) DO UPDATE SET status = 'processing', attempts = excluded.attempts, updated_at = datetime('now')`,
  )
    .bind(thread.id, attempts)
    .run();

  try {
    // フォーラムの投稿の最初のメッセージの ID は、スレッドの ID と同じ
    const msg = await botApi<DiscordMessage>(token, `/channels/${thread.id}/messages/${thread.id}`);
    const posted = todayYMD(env.TIMEZONE, new Date(msg.timestamp));
    const paidOnDiscord = !!tags.paid && (thread.applied_tags ?? []).includes(tags.paid);

    // すでにシートに行があれば（前回の途中で失敗した場合など）追加しない
    let rowNumber = rows.get(thread.id)?.row;
    let summary: string;
    if (!rowNumber) {
      const attachments = msg.attachments.filter((a) => supportedType(a) && a.size <= MAX_BYTES).slice(0, MAX_FILES_PER_BILL);
      const skippedFiles = msg.attachments.length - attachments.length;
      const files = await Promise.all(
        attachments.map(async (a) => {
          const res = await fetch(a.url);
          if (!res.ok) throw new Error(`添付ファイルの取得に失敗 (${res.status})`);
          return { data: await res.arrayBuffer(), contentType: supportedType(a)!, filename: a.filename };
        }),
      );
      const info = await extractBill(env, { title: thread.name ?? '', body: msg.content ?? '', files, today: ymdString(todayYMD(env.TIMEZONE)) });
      await env.DB.prepare(
        `UPDATE bills SET title = ?, payee = ?, amount = ?, due_date = ?, method = ?, bank_info = ?, notes = ?, ocr_text = ?,
           input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?, updated_at = datetime('now')
         WHERE thread_id = ?`,
      )
        .bind(info.title, info.payee, info.amount, info.dueDate, info.method, info.bankInfo, info.notes, info.text, info.inputTokens, info.outputTokens, thread.id)
        .run();

      const link = `https://discord.com/channels/${env.GUILD_ID}/${thread.id}`;
      rowNumber = await appendBillRow(env, sheet, {
        登録日: slash(posted),
        支払期限: info.dueDate ? info.dueDate.replace(/-/g, '/') : '',
        支払い先: info.payee,
        金額: info.amount ?? '',
        内容: info.title,
        支払方法: info.method,
        振込先: info.bankInfo,
        状態: paidOnDiscord ? STATUS_PAID : STATUS_UNPAID,
        支払日: paidOnDiscord ? slash(todayYMD(env.TIMEZONE)) : '',
        Discord: `=HYPERLINK("${link}","開く")`,
        管理番号: `'${thread.id}`,
      });

      const unknown = '（読み取れませんでした）';
      const due = info.dueDate ? formatDayLabel(parseYmd(info.dueDate)) + (info.dueDate.slice(0, 4) !== String(posted.y) ? `（${info.dueDate.slice(0, 4)}年）` : '') : unknown;
      summary = [
        `💴 **${info.title || '請求'}** をスプレッドシートに転記しました`,
        `・支払い先：${info.payee || unknown}`,
        `・金額：${info.amount !== null ? `¥${info.amount.toLocaleString('ja-JP')}` : unknown}`,
        `・支払期限：${due}`,
        `・支払方法：${info.method}`,
        ...(info.bankInfo ? [`・振込先：${info.bankInfo}`] : []),
        ...(info.notes ? [`・メモ：${info.notes}`] : []),
        `📊 [スプレッドシートで開く](<${rowUrl(sheet, rowNumber)}>)`,
        ...(skippedFiles > 0
          ? [`⚠️ 読み取れなかった添付ファイルが${skippedFiles}件あります（HEIC 形式・20MB 超・5件目以降など）。必要ならシートを手で直してください。`]
          : []),
        '-# 内容に誤りがあればシートで直してください。支払ったら「支払済み」タグを付けるか、シートの状態を「支払い済」にしてください（5分ほどで両方に反映されます）。',
      ].join('\n');
    } else {
      summary = `💴 スプレッドシートに転記しました\n📊 [スプレッドシートで開く](<${rowUrl(sheet, rowNumber)}>)`;
    }

    await env.DB.prepare("UPDATE bills SET status = 'done', paid = ?, error = NULL, updated_at = datetime('now') WHERE thread_id = ?")
      .bind(paidOnDiscord ? 1 : 0, thread.id)
      .run();

    // 「転記」タグを付けて、登録内容を返信する
    if (tags.transcribed && !(thread.applied_tags ?? []).includes(tags.transcribed)) {
      await botApi(token, `/channels/${thread.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ applied_tags: [...(thread.applied_tags ?? []), tags.transcribed].slice(0, 5), ...(thread.thread_metadata?.archived ? { archived: false } : {}) }),
      }).catch((e) => console.error('bills: タグ付けに失敗', thread.id, e));
    }
    await botApi(token, `/channels/${thread.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: summary, allowed_mentions: { parse: [] }, message_reference: { message_id: thread.id, fail_if_not_exists: false } }),
    });
  } catch (e) {
    console.error('bills: 転記に失敗', thread.id, e);
    const message = e instanceof Error ? e.message : String(e);
    const setup = isSetupProblem(e);
    await env.DB.prepare("UPDATE bills SET status = 'error', error = ?, attempts = ?, updated_at = datetime('now') WHERE thread_id = ?")
      .bind(message.slice(0, 500), setup ? attempts - 1 : attempts, thread.id)
      .run();
    if (!setup && attempts >= MAX_ATTEMPTS) {
      await botApi(token, `/channels/${thread.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '⚠️ この請求の読み取り・転記に失敗しました。お手数ですが、スプレッドシートに手で入力してください。', allowed_mentions: { parse: [] } }),
      }).catch(() => {});
    }
  }
}
