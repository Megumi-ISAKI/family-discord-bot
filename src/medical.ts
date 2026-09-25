// 医療費の領収書（Phase 6・確定申告用）
// 5分おきに 🏥-医療費（フォーラム）を確認し、領収書（画像・PDF 1つ＝1枚。写真のない投稿は本文）ごとに
//  1) OpenAI で医療を受けた人・支払先・区分・金額・支払日を読み取る
//  2) 写真を家族アカウントのドライブの「yyyy年」フォルダに保存する（年は支払日で判定）
//  3) 「yyyy年医療費」シート（国税庁の医療費集計フォームと同じ並び）に1行追加する
//  4) 投稿に返信し、「転記済み」タグを付ける

import type { Env } from './types';
import { botApi, type DiscordAttachment, type DiscordMessage, type DiscordThread } from './discord';
import { ensureFolder, ensureSpreadsheet, uniqueName, uploadFile } from './drive';
import { GoogleApiError, GoogleAuthError } from './google';
import { MEDICAL_CATEGORIES, extractMedical, type MedicalInfo } from './openai';
import { safeTitle, supportedType, yyyymmdd } from './otayori';
import { appendRow, colLetter, currencyFormat, dropdown, hideColumn, openSheet, range, rowUrl, sheetsJson, type Formatter, type SheetInfo } from './sheets';
import { formatDayLabel, todayYMD, ymdString, type YMD } from './time';

/** 1回の実行で処理する最大枚数（Workers 無料プランの外部通信 50 回に収めるため。年のシートを作る回は通信が増える） */
const MAX_RECEIPTS_PER_RUN = 2;
const MAX_ATTEMPTS = 3;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_THREADS_PER_RUN = 10;
const MAX_DESCRIPTION = 25000;
/** 状態を表すタグ（これ以外のタグは「医療を受けた人」とみなす） */
const TAG_DONE = '転記済';
const STATUS_TAG = /転記|保存/;

/** 国税庁「医療費集計フォーム」と同じ並び＋Bot が使う列 */
export const MEDICAL_COLUMNS = [
  '医療を受けた人',
  '病院・薬局などの支払先の名称',
  ...MEDICAL_CATEGORIES,
  '支払った医療費の金額',
  '左のうち、補填される金額',
  '支払年月日',
  'メモ',
  '領収書',
  'Discord',
  '管理番号',
] as const;
const MARK = '該当する';

const EXT_BY_TYPE: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

interface ReceiptRow {
  receipt_id: string;
  message_id: string;
  thread_id: string;
  filename: string | null;
  status: string;
  attempts: number;
  patient: string | null;
  payee: string | null;
  category: string | null;
  amount: number | null;
  paid_date: string | null;
  notes: string | null;
  ocr_text: string | null;
  year: number | null;
  sheet_id: string | null;
  sheet_row: number | null;
  drive_file_id: string | null;
  drive_name: string | null;
}

const medicalFormat: Formatter = (ctx) => {
  const requests: unknown[] = [];
  for (const c of MEDICAL_CATEGORIES) if (ctx.added.includes(c)) requests.push(dropdown(ctx, c, [MARK]));
  for (const c of ['支払った医療費の金額', '左のうち、補填される金額']) if (ctx.added.includes(c)) requests.push(currencyFormat(ctx, c));
  if (ctx.added.includes('管理番号')) requests.push(hideColumn(ctx, '管理番号'));
  return requests;
};

function parseYmd(s: string): YMD {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function isSetupProblem(e: unknown): boolean {
  return (
    e instanceof GoogleAuthError ||
    (e instanceof GoogleApiError && (e.status === 403 || e.status === 404) && /SERVICE_DISABLED|accessNotConfigured|insufficient|SCOPE|permission|not found/i.test(e.message))
  );
}

// ───────────── 年ごとのシート ─────────────

/** 1回の実行の中で開いたシート（通信を減らすため） */
const openedSheets = new Map<number, SheetInfo>();

async function medicalSheet(env: Env, year: number): Promise<SheetInfo> {
  const cached = openedSheets.get(year);
  if (cached) return cached;

  const key = `medical_sheet_${year}`;
  let id = (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value;
  let created = false;
  if (!id) {
    const found = await ensureSpreadsheet(env, env.MEDICAL_FOLDER_ID, `${year}年医療費`);
    id = found.id;
    created = found.created;
    if (created) {
      // 先頭のタブを「医療費」に、集計用のタブを追加
      const meta = await sheetsJson<{ sheets: { properties: { sheetId: number } }[] }>(env, `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(sheetId)`);
      await sheetsJson(env, `https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            { updateSheetProperties: { properties: { sheetId: meta.sheets[0].properties.sheetId, title: '医療費' }, fields: 'title' } },
            { addSheet: { properties: { title: '集計' } } },
          ],
        }),
      });
    }
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, id).run();
  }

  const sheet = await openSheet(env, id, MEDICAL_COLUMNS, medicalFormat);
  if (created) await writeSummary(env, sheet, year);
  openedSheets.set(year, sheet);
  return sheet;
}

/** 「集計」タブ：合計・差引・控除の目安・人ごとの合計 */
async function writeSummary(env: Env, sheet: SheetInfo, year: number) {
  const col = (name: string) => colLetter(sheet.columns.get(name)!);
  const t = `'${sheet.tab}'`;
  const [who, paid, covered] = [col('医療を受けた人'), col('支払った医療費の金額'), col('左のうち、補填される金額')];
  const values = [
    [`${year}年 医療費の集計`, ''],
    ['支払った医療費の合計', `=SUM(${t}!${paid}2:${paid})`],
    ['補填される金額の合計', `=SUM(${t}!${covered}2:${covered})`],
    ['差引（支払額 − 補填額）', '=B2-B3'],
    ['医療費控除の目安（差引 − 10万円）', '=MAX(0,B4-100000)'],
    ['※総所得金額等が200万円未満の人は、10万円ではなく総所得金額等の5%を差し引きます。控除の上限は200万円です。', ''],
    ['', ''],
    ['人ごとの合計', ''],
    [
      `=QUERY(${t}!${who}2:${covered}, "select ${who}, sum(${paid}), sum(${covered}) where ${who} is not null group by ${who} label ${who} '医療を受けた人', sum(${paid}) '支払額', sum(${covered}) '補填額'", 0)`,
      '',
    ],
  ];
  await sheetsJson(env, `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${range('集計', 'A1')}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
  const meta = await sheetsJson<{ sheets: { properties: { title: string; sheetId: number } }[] }>(
    env,
    `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}?fields=sheets.properties(title,sheetId)`,
  );
  const gid = meta.sheets.find((s) => s.properties.title === '集計')?.properties.sheetId;
  if (gid === undefined) return;
  const yen = { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"¥"#,##0' } } };
  await sheetsJson(env, `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        { repeatCell: { range: { sheetId: gid, startRowIndex: 1, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 }, cell: yen, fields: 'userEnteredFormat.numberFormat' } },
        { repeatCell: { range: { sheetId: gid, startRowIndex: 9, startColumnIndex: 1, endColumnIndex: 3 }, cell: yen, fields: 'userEnteredFormat.numberFormat' } },
        { repeatCell: { range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
        { updateDimensionProperties: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 280 }, fields: 'pixelSize' } },
      ],
    }),
  });
}

// ───────────── 確認と処理 ─────────────

export async function pollMedical(env: Env): Promise<void> {
  openedSheets.clear();
  const token = env.DISCORD_BOT_TOKEN;
  const [forum, active, archived] = await Promise.all([
    botApi<{ available_tags?: { id: string; name: string }[] }>(token, `/channels/${env.MEDICAL_CHANNEL_ID}`),
    botApi<{ threads: DiscordThread[] }>(token, `/guilds/${env.GUILD_ID}/threads/active`),
    botApi<{ threads: DiscordThread[] }>(token, `/channels/${env.MEDICAL_CHANNEL_ID}/threads/archived/public?limit=50`),
  ]);
  const tags = forum.available_tags ?? [];
  const doneTag = tags.find((t) => t.name.includes(TAG_DONE))?.id ?? null;
  const people = tags.filter((t) => !STATUS_TAG.test(t.name));
  const family = people.map((t) => t.name);
  const threads = new Map<string, DiscordThread>();
  for (const t of [...archived.threads, ...active.threads.filter((t) => t.parent_id === env.MEDICAL_CHANNEL_ID)]) threads.set(t.id, t);

  let budget = MAX_RECEIPTS_PER_RUN;
  const touched = new Set<string>();

  // 1) 失敗したもののやり直し
  const { results: retries } = await env.DB.prepare(
    "SELECT * FROM medical_receipts WHERE status IN ('error', 'processing') AND attempts < ? AND updated_at < datetime('now', '-4 minutes') ORDER BY created_at LIMIT ?",
  )
    .bind(MAX_ATTEMPTS, budget)
    .all<ReceiptRow>();
  for (const row of retries) {
    try {
      const msg = await botApi<DiscordMessage>(token, `/channels/${row.thread_id}/messages/${row.message_id}`);
      const isText = row.receipt_id.startsWith('text-');
      const att = isText ? null : msg.attachments.find((a) => a.id === row.receipt_id);
      if (!isText && !att) {
        await env.DB.prepare("UPDATE medical_receipts SET status = 'skipped', error = ? WHERE receipt_id = ?").bind('元の写真が削除されています', row.receipt_id).run();
        continue;
      }
      const thread = threads.get(row.thread_id) ?? (await botApi<DiscordThread>(token, `/channels/${row.thread_id}`));
      await processReceipt(env, thread, msg, att ?? null, row, family, people);
      touched.add(row.thread_id);
    } catch (e) {
      console.error('medical retry failed', row.receipt_id, e);
      await env.DB.prepare("UPDATE medical_receipts SET status = 'skipped', error = ? WHERE receipt_id = ?").bind('元の投稿を取得できません', row.receipt_id).run();
    }
    budget--;
  }

  // 2) 新しい領収書
  const { results: cursorRows } = await env.DB.prepare('SELECT thread_id, last_message_id FROM medical_threads').all<{ thread_id: string; last_message_id: string }>();
  const cursors = new Map(cursorRows.map((r) => [r.thread_id, r.last_message_id]));
  const gt = (a: string, b: string) => BigInt(a) > BigInt(b);
  let checked = 0;
  for (const thread of [...threads.values()].sort((a, b) => (gt(a.id, b.id) ? 1 : -1))) {
    if (budget <= 0 || checked >= MAX_THREADS_PER_RUN) break;
    const cursor = cursors.get(thread.id) ?? '0';
    if (!thread.last_message_id || !gt(thread.last_message_id, cursor)) continue;
    checked++;

    const messages = await botApi<DiscordMessage[]>(token, `/channels/${thread.id}/messages?after=${cursor}&limit=50`);
    messages.sort((a, b) => (gt(a.id, b.id) ? 1 : -1));
    let newCursor = cursor;
    let stopped = false;
    for (const msg of messages) {
      if (!msg.author.bot && (msg.type === 0 || msg.type === 19)) {
        // 添付ごとに1枚。写真のない「最初の投稿」は本文を1枚として扱う（返信の文章は会話とみなして読まない）
        const units: (DiscordAttachment | null)[] = msg.attachments.length ? msg.attachments : msg.id === thread.id ? [null] : [];
        for (const att of units) {
          const receiptId = att ? att.id : `text-${msg.id}`;
          if (await env.DB.prepare('SELECT 1 FROM medical_receipts WHERE receipt_id = ?').bind(receiptId).first()) continue;
          if (budget <= 0) {
            stopped = true;
            break;
          }
          await env.DB.prepare("INSERT OR IGNORE INTO medical_receipts (receipt_id, message_id, thread_id, filename, status) VALUES (?, ?, ?, ?, 'processing')")
            .bind(receiptId, msg.id, thread.id, att?.filename ?? null)
            .run();
          const row = await env.DB.prepare('SELECT * FROM medical_receipts WHERE receipt_id = ?').bind(receiptId).first<ReceiptRow>();
          if (await processReceipt(env, thread, msg, att, row!, family, people)) budget--;
          touched.add(thread.id);
        }
      }
      if (stopped) break;
      newCursor = msg.id;
    }
    if (newCursor !== cursor) {
      await env.DB.prepare(
        'INSERT INTO medical_threads (thread_id, last_message_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET last_message_id = excluded.last_message_id',
      )
        .bind(thread.id, newCursor)
        .run();
    }
  }

  // 3) 処理が済んだ投稿に「転記済み」タグ
  if (!doneTag) return;
  for (const id of touched) {
    const ok = await env.DB.prepare("SELECT 1 FROM medical_receipts WHERE thread_id = ? AND status = 'done'").bind(id).first();
    const thread = threads.get(id);
    if (!ok || !thread || (thread.applied_tags ?? []).includes(doneTag)) continue;
    await botApi(token, `/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ applied_tags: [...(thread.applied_tags ?? []), doneTag].slice(0, 5), ...(thread.thread_metadata?.archived ? { archived: false } : {}) }),
    }).catch((e) => console.error('medical tag failed', id, e));
  }
}

async function reply(env: Env, msg: DiscordMessage, content: string) {
  await botApi(env.DISCORD_BOT_TOKEN, `/channels/${msg.channel_id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, message_reference: { message_id: msg.id, fail_if_not_exists: false } }),
  });
}

/** 領収書1枚を処理する。OpenAI を使った（上限に数える）なら true */
async function processReceipt(
  env: Env,
  thread: DiscordThread,
  msg: DiscordMessage,
  att: DiscordAttachment | null,
  row: ReceiptRow,
  family: string[],
  people: { id: string; name: string }[],
): Promise<boolean> {
  const type = att ? supportedType(att) : null;
  if (att && !type) {
    await env.DB.prepare("UPDATE medical_receipts SET status = 'skipped', error = ? WHERE receipt_id = ?").bind(`未対応の形式: ${att.content_type ?? att.filename}`, row.receipt_id).run();
    await reply(env, msg, `⚠️ 「${att.filename}」は読み取れない形式です。写真（JPEG・PNG）か PDF で投稿してください。\n-# iPhone の場合は「設定 → カメラ → フォーマット → 互換性優先」にすると JPEG で保存されます。`);
    return false;
  }
  if (att && att.size > MAX_BYTES) {
    await env.DB.prepare("UPDATE medical_receipts SET status = 'skipped', error = ? WHERE receipt_id = ?").bind('大きすぎるファイル', row.receipt_id).run();
    await reply(env, msg, `⚠️ 「${att.filename}」は大きすぎるため読み取れません（20MB まで）。`);
    return false;
  }

  const attempts = row.attempts + 1;
  await env.DB.prepare("UPDATE medical_receipts SET attempts = ?, status = 'processing', updated_at = datetime('now') WHERE receipt_id = ?").bind(attempts, row.receipt_id).run();

  try {
    const data = att ? await (async () => {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`添付ファイルの取得に失敗 (${res.status})`);
      return res.arrayBuffer();
    })() : null;

    // 1. 読み取り（済んでいれば省略）
    let info: Pick<MedicalInfo, 'patient' | 'payee' | 'category' | 'amount' | 'paidDate' | 'notes' | 'text'>;
    if (row.payee === null) {
      const tagged = people.filter((p) => (thread.applied_tags ?? []).includes(p.id)).map((p) => p.name);
      const r = await extractMedical(env, {
        today: ymdString(todayYMD(env.TIMEZONE)),
        postTitle: thread.name ?? '',
        body: msg.content ?? '',
        family,
        tagged,
        file: att && data ? { data, contentType: type!, filename: att.filename } : undefined,
      });
      // タグが1人だけなら、その人を「医療を受けた人」にする
      if (tagged.length === 1) r.patient = tagged[0];
      if (!r.paidDate) r.paidDate = ymdString(todayYMD(env.TIMEZONE, new Date(msg.timestamp)));
      info = r;
      await env.DB.prepare(
        `UPDATE medical_receipts SET patient = ?, payee = ?, category = ?, amount = ?, paid_date = ?, notes = ?, ocr_text = ?, year = ?,
           input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?, updated_at = datetime('now')
         WHERE receipt_id = ?`,
      )
        .bind(r.patient, r.payee, r.category, r.amount, r.paidDate, r.notes, r.text, Number(r.paidDate.slice(0, 4)), r.inputTokens, r.outputTokens, row.receipt_id)
        .run();
    } else {
      info = {
        patient: row.patient ?? '',
        payee: row.payee,
        category: (row.category ?? 'その他の医療費') as MedicalInfo['category'],
        amount: row.amount,
        paidDate: row.paid_date ?? '',
        notes: row.notes ?? '',
        text: row.ocr_text ?? '',
      };
    }
    const paid = parseYmd(info.paidDate);
    const year = paid.y;

    // 2. 写真をドライブの「yyyy年」フォルダに保存（済んでいれば省略）
    let driveId = row.drive_file_id;
    let driveName = row.drive_name;
    if (att && data && !driveId) {
      const folderId = await ensureFolder(env, env.MEDICAL_FOLDER_ID, `${year}年`);
      const base = [yyyymmdd(paid), safeTitle(info.payee || '医療費'), info.patient ? safeTitle(info.patient) : ''].filter(Boolean).join('_');
      driveName = await uniqueName(env, folderId, base, EXT_BY_TYPE[type!]);
      const uploaded = await uploadFile(env, { folderId, name: driveName, mimeType: type!, description: (info.text || '').slice(0, MAX_DESCRIPTION), data });
      driveId = uploaded.id;
      await env.DB.prepare("UPDATE medical_receipts SET drive_file_id = ?, drive_name = ?, updated_at = datetime('now') WHERE receipt_id = ?").bind(driveId, driveName, row.receipt_id).run();
    }
    const driveUrl = driveId ? `https://drive.google.com/file/d/${driveId}/view` : '';

    // 3. 「yyyy年医療費」シートに転記（済んでいれば省略）
    const sheet = await medicalSheet(env, year);
    let sheetRow = row.sheet_row;
    if (!sheetRow) {
      const discordUrl = `https://discord.com/channels/${env.GUILD_ID}/${thread.id}/${msg.id}`;
      sheetRow = await appendRow(env, sheet, {
        医療を受けた人: info.patient,
        '病院・薬局などの支払先の名称': info.payee,
        [info.category]: MARK,
        支払った医療費の金額: info.amount ?? '',
        '左のうち、補填される金額': '',
        支払年月日: info.paidDate.replace(/-/g, '/'),
        メモ: info.notes,
        領収書: driveUrl ? `=HYPERLINK("${driveUrl}","開く")` : '',
        Discord: `=HYPERLINK("${discordUrl}","開く")`,
        管理番号: `'${row.receipt_id}`,
      });
      await env.DB.prepare("UPDATE medical_receipts SET sheet_id = ?, sheet_row = ?, updated_at = datetime('now') WHERE receipt_id = ?").bind(sheet.id, sheetRow, row.receipt_id).run();
    }

    // 4. 返信
    const unknown = '（読み取れませんでした）';
    const content = [
      `🏥 **${info.payee || '医療費'}**${info.patient ? `（${info.patient}）` : ''} を ${year}年医療費 に転記しました`,
      `・区分：${info.category}`,
      `・金額：${info.amount !== null ? `¥${info.amount.toLocaleString('ja-JP')}` : unknown}`,
      `・支払日：${formatDayLabel(paid)}${year !== todayYMD(env.TIMEZONE).y ? `（${year}年）` : ''}`,
      ...(info.notes ? [`・メモ：${info.notes}`] : []),
      ...(!info.patient ? ['⚠️ 医療を受けた人がわかりませんでした。投稿に名前のタグを付けるか、シートに入力してください。'] : []),
      ...(driveName ? [`📁 ${year}年 / ${driveName}　[ドライブで開く](<${driveUrl}>)`] : []),
      `📊 [シートで開く](<${rowUrl(sheet, sheetRow)}>)`,
      '-# 保険金・高額療養費などで補填される金額があれば、シートの「左のうち、補填される金額」に入力してください。',
    ].join('\n');
    await reply(env, msg, content);
    await env.DB.prepare("UPDATE medical_receipts SET status = 'done', error = NULL, updated_at = datetime('now') WHERE receipt_id = ?").bind(row.receipt_id).run();
  } catch (e) {
    console.error('medical failed', row.receipt_id, e);
    const message = e instanceof Error ? e.message : String(e);
    const setup = isSetupProblem(e);
    await env.DB.prepare("UPDATE medical_receipts SET status = 'error', error = ?, attempts = ?, updated_at = datetime('now') WHERE receipt_id = ?")
      .bind(message.slice(0, 500), setup ? attempts - 1 : attempts, row.receipt_id)
      .run();
    if (!setup && attempts >= MAX_ATTEMPTS) {
      await reply(env, msg, `⚠️ ${att ? `「${att.filename}」` : 'この投稿'}の読み取り・転記に失敗しました。お手数ですが、もう一度投稿するか、シートに手で入力してください。`).catch(() => {});
    }
  }
  return true;
}
