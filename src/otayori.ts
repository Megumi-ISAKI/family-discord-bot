// おたよりOCR（Phase 3）
// 5分おきに 📮-おたより等提出（フォーラム）の新しい投稿を確認し、
// 添付の画像・PDF を OpenAI で読み取って、家族アカウントのドライブに年度別で保存し、全文を返信する。

import type { Env } from './types';
import { botApi, type DiscordAttachment, type DiscordMessage, type DiscordThread } from './discord';
import { ensureFolder, uniqueName, uploadFile } from './drive';
import { GoogleApiError, GoogleAuthError } from './google';
import { ocrOtayori } from './openai';
import { todayYMD, type YMD } from './time';

/** 1回の実行で処理する最大枚数（Workers 無料プランの外部通信回数 50 回に収めるため） */
const MAX_FILES_PER_RUN = 3;
/** 家族全体で1日に処理する最大枚数（OpenAI の使いすぎ防止） */
const DAILY_LIMIT = 20;
/** 失敗したときに自動でやり直す回数の上限 */
const MAX_ATTEMPTS = 3;
/** OpenAI に送れるファイルの大きさの上限 */
const MAX_BYTES = 20 * 1024 * 1024;
/** 一度に確認するスレッド数の上限 */
const MAX_THREADS_PER_RUN = 10;
/** Discord の1メッセージの文字数上限（2000）に余裕を持たせた値 */
const CHUNK = 1900;
/** 返信で全文を載せる最大メッセージ数（残りはドライブの説明欄を案内） */
const MAX_REPLY_MESSAGES = 4;
/** ドライブの説明欄に入れる最大文字数 */
const MAX_DESCRIPTION = 25000;

const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** 対応している形式なら MIME タイプを返す（HEIC などは未対応） */
export function supportedType(att: Pick<DiscordAttachment, 'filename' | 'content_type'>): string | null {
  const ct = att.content_type?.split(';')[0].trim().toLowerCase();
  if (ct && (Object.values(IMAGE_TYPES).includes(ct) || ct === 'application/pdf')) return ct;
  const ext = att.filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'application/pdf';
  return IMAGE_TYPES[ext] ?? null;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

/** 学校の年度（4月始まり）。2027年3月の投稿 → 2026年度 */
export function fiscalYear(ymd: YMD): number {
  return ymd.m >= 4 ? ymd.y : ymd.y - 1;
}

export function yyyymmdd(ymd: YMD): string {
  return `${ymd.y}${String(ymd.m).padStart(2, '0')}${String(ymd.d).padStart(2, '0')}`;
}

/** ファイル名に使えない文字を置き換え、長さをそろえる */
export function safeTitle(title: string): string {
  const t = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, '・')
    .replace(/\s+/g, ' ')
    .replace(/^[.・\s]+|[.・\s]+$/g, '')
    .slice(0, 40);
  return t || 'おたより';
}

/** 文章を Discord の文字数上限に合わせて分ける（なるべく改行で区切る） */
export function chunkText(text: string, size = CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Discord の ID（snowflake）をある時刻から作る。これより後の投稿だけを対象にするために使う */
function snowflakeAt(ms: number): string {
  return ((BigInt(ms) - 1420070400000n) << 22n).toString();
}

const gt = (a: string, b: string) => BigInt(a) > BigInt(b);

interface FileRow {
  attachment_id: string;
  message_id: string;
  thread_id: string;
  filename: string;
  status: string;
  attempts: number;
  title: string | null;
  ocr_text: string | null;
  drive_file_id: string | null;
  drive_name: string | null;
}

/** おたよりOCRを始めた時点（これより前の投稿は処理しない） */
async function startId(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'otayori_start_id'").first<{ value: string }>();
  if (row) return row.value;
  const id = snowflakeAt(Date.now());
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('otayori_start_id', ?)").bind(id).run();
  return id;
}

/** 今日（日本時間）に処理した枚数 */
async function countToday(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM otayori_files WHERE date(created_at, '+9 hours') = date('now', '+9 hours') AND status != 'skipped'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 処理が済んだ投稿に付けるタグの名前（この文字を含むタグを探す） */
const SAVED_TAG_NAME = '保存済み';
/** フォーラムの投稿に付けられるタグの最大数 */
const MAX_TAGS = 5;

/** 1回の実行の中で、タグの確認・付与を済ませたスレッドとタグID（外部通信を減らすため） */
let savedTagId: string | null | undefined;
const taggedThreads = new Set<string>();

async function findSavedTag(env: Env): Promise<string | null> {
  if (savedTagId !== undefined) return savedTagId;
  const forum = await botApi<{ available_tags?: { id: string; name: string }[] }>(env.DISCORD_BOT_TOKEN, `/channels/${env.OTAYORI_CHANNEL_ID}`);
  savedTagId = forum.available_tags?.find((t) => t.name.includes(SAVED_TAG_NAME))?.id ?? null;
  if (!savedTagId) console.log(`otayori: 「${SAVED_TAG_NAME}」タグが見つからないため、タグは付けません`);
  return savedTagId;
}

/** 投稿（スレッド）に「✅ 保存済み」タグを付ける。Bot に「スレッドの管理」権限が必要 */
export async function markSaved(env: Env, threadId: string): Promise<void> {
  if (taggedThreads.has(threadId)) return;
  taggedThreads.add(threadId);
  const tagId = await findSavedTag(env);
  if (!tagId) return;
  const thread = await botApi<DiscordThread>(env.DISCORD_BOT_TOKEN, `/channels/${threadId}`);
  const tags = thread.applied_tags ?? [];
  if (tags.includes(tagId) || tags.length >= MAX_TAGS) return;
  await botApi(env.DISCORD_BOT_TOKEN, `/channels/${threadId}`, { method: 'PATCH', body: JSON.stringify({ applied_tags: [...tags, tagId] }) });
}

export async function pollOtayori(env: Env): Promise<void> {
  savedTagId = undefined;
  taggedThreads.clear();
  const start = await startId(env);
  let budget = Math.min(MAX_FILES_PER_RUN, DAILY_LIMIT - (await countToday(env)));
  if (budget <= 0) {
    console.log('otayori: 今日の上限に達しているため、明日以降に処理します');
    return;
  }

  // 1) 失敗したものをやり直す（Discord の添付 URL は期限があるので、メッセージを取り直す）
  const { results: retries } = await env.DB.prepare(
    "SELECT * FROM otayori_files WHERE status IN ('error', 'processing') AND attempts < ? AND updated_at < datetime('now', '-4 minutes') ORDER BY created_at LIMIT ?",
  )
    .bind(MAX_ATTEMPTS, budget)
    .all<FileRow>();
  for (const row of retries) {
    try {
      const msg = await botApi<DiscordMessage>(env.DISCORD_BOT_TOKEN, `/channels/${row.thread_id}/messages/${row.message_id}`);
      const att = msg.attachments.find((a) => a.id === row.attachment_id);
      if (att) await processAttachment(env, msg, att, row);
      else await setStatus(env, row.attachment_id, 'skipped', '元の投稿が削除されています');
    } catch (e) {
      console.error('otayori retry failed', row.attachment_id, e);
      await setStatus(env, row.attachment_id, 'skipped', '元の投稿を取得できません');
    }
    budget--;
  }
  if (budget <= 0) return;

  // 2) 新しい投稿を探す
  const { threads } = await botApi<{ threads: DiscordThread[] }>(env.DISCORD_BOT_TOKEN, `/guilds/${env.GUILD_ID}/threads/active`);
  const forum = threads.filter((t) => t.parent_id === env.OTAYORI_CHANNEL_ID && t.last_message_id && gt(t.last_message_id, start));
  if (forum.length === 0) return;

  const { results: cursorRows } = await env.DB.prepare('SELECT thread_id, last_message_id FROM otayori_threads').all<{
    thread_id: string;
    last_message_id: string;
  }>();
  const cursors = new Map(cursorRows.map((r) => [r.thread_id, r.last_message_id]));

  let checked = 0;
  for (const thread of forum) {
    if (budget <= 0 || checked >= MAX_THREADS_PER_RUN) break;
    const cursor = cursors.get(thread.id) ?? (BigInt(start) - 1n).toString();
    if (!gt(thread.last_message_id!, cursor)) continue;
    checked++;

    const messages = await botApi<DiscordMessage[]>(env.DISCORD_BOT_TOKEN, `/channels/${thread.id}/messages?after=${cursor}&limit=50`);
    messages.sort((a, b) => (gt(a.id, b.id) ? 1 : -1));

    let newCursor = cursor;
    let stopped = false;
    for (const msg of messages) {
      if (!msg.author.bot && (msg.type === 0 || msg.type === 19)) {
        for (const att of msg.attachments) {
          const exists = await env.DB.prepare('SELECT 1 FROM otayori_files WHERE attachment_id = ?').bind(att.id).first();
          if (exists) continue;
          if (budget <= 0) {
            stopped = true; // 続きは次回。このメッセージから再開する
            break;
          }
          await env.DB.prepare(
            "INSERT OR IGNORE INTO otayori_files (attachment_id, message_id, thread_id, filename, status) VALUES (?, ?, ?, ?, 'processing')",
          )
            .bind(att.id, msg.id, msg.channel_id, att.filename)
            .run();
          const row = await env.DB.prepare('SELECT * FROM otayori_files WHERE attachment_id = ?').bind(att.id).first<FileRow>();
          await processAttachment(env, msg, att, row!);
          if (supportedType(att) && att.size <= MAX_BYTES) budget--;
        }
      }
      if (stopped) break;
      newCursor = msg.id;
    }

    if (newCursor !== cursor) {
      await env.DB.prepare(
        'INSERT INTO otayori_threads (thread_id, last_message_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET last_message_id = excluded.last_message_id',
      )
        .bind(thread.id, newCursor)
        .run();
    }
  }
}

async function setStatus(env: Env, attachmentId: string, status: string, error: string | null = null) {
  await env.DB.prepare("UPDATE otayori_files SET status = ?, error = ?, updated_at = datetime('now') WHERE attachment_id = ?")
    .bind(status, error, attachmentId)
    .run();
}

async function reply(env: Env, msg: DiscordMessage, content: string, reference = true) {
  await botApi(env.DISCORD_BOT_TOKEN, `/channels/${msg.channel_id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
      ...(reference ? { message_reference: { message_id: msg.id, fail_if_not_exists: false } } : {}),
    }),
  });
}

/** 1つの添付ファイルを読み取り・保存・返信する。途中まで終わっていれば続きから行う */
async function processAttachment(env: Env, msg: DiscordMessage, att: DiscordAttachment, row: FileRow): Promise<void> {
  const type = supportedType(att);
  if (!type) {
    await setStatus(env, att.id, 'skipped', `未対応の形式: ${att.content_type ?? att.filename}`);
    await reply(env, msg, `⚠️ 「${att.filename}」は読み取れない形式です。写真（JPEG・PNG）か PDF で投稿してください。\n-# iPhone の場合は「設定 → カメラ → フォーマット → 互換性優先」にすると JPEG で保存されます。`);
    return;
  }
  if (att.size > MAX_BYTES) {
    await setStatus(env, att.id, 'skipped', `大きすぎるファイル: ${att.size} bytes`);
    await reply(env, msg, `⚠️ 「${att.filename}」は大きすぎるため読み取れません（20MB まで）。`);
    return;
  }

  const attempts = row.attempts + 1;
  await env.DB.prepare("UPDATE otayori_files SET attempts = ?, status = 'processing', updated_at = datetime('now') WHERE attachment_id = ?")
    .bind(attempts, att.id)
    .run();

  try {
    const fileRes = await fetch(att.url);
    if (!fileRes.ok) throw new Error(`添付ファイルの取得に失敗 (${fileRes.status})`);
    const data = await fileRes.arrayBuffer();

    // 1. 読み取り（済んでいれば省略）
    let title = row.title;
    let text = row.ocr_text;
    if (title === null || text === null) {
      const ocr = await ocrOtayori(env, { data, contentType: type, filename: att.filename });
      title = safeTitle(ocr.title);
      text = ocr.text;
      await env.DB.prepare(
        "UPDATE otayori_files SET title = ?, ocr_text = ?, input_tokens = ?, output_tokens = ?, updated_at = datetime('now') WHERE attachment_id = ?",
      )
        .bind(title, text, ocr.inputTokens, ocr.outputTokens, att.id)
        .run();
    }

    // 2. ドライブに保存（済んでいれば省略）
    const posted = todayYMD(env.TIMEZONE, new Date(msg.timestamp));
    const fy = fiscalYear(posted);
    let driveName = row.drive_name;
    let link = row.drive_file_id ? `https://drive.google.com/file/d/${row.drive_file_id}/view` : null;
    if (!row.drive_file_id) {
      const folderId = await ensureFolder(env, env.OTAYORI_DRIVE_FOLDER_ID, `${fy}年度`);
      driveName = await uniqueName(env, folderId, `${yyyymmdd(posted)}_${title}`, EXT_BY_TYPE[type]);
      const uploaded = await uploadFile(env, {
        folderId,
        name: driveName,
        mimeType: type,
        description: (text || '（文字は読み取れませんでした）').slice(0, MAX_DESCRIPTION),
        data,
      });
      link = uploaded.webViewLink;
      await env.DB.prepare("UPDATE otayori_files SET drive_file_id = ?, drive_name = ?, updated_at = datetime('now') WHERE attachment_id = ?")
        .bind(uploaded.id, driveName, att.id)
        .run();
    }

    // 3. 返信（見出し＋全文。長い場合は分けて投稿）
    const header = `📄 **${title}**\n📁 ${fy}年度 / ${driveName}　[ドライブで開く](<${link}>)`;
    const chunks = text ? chunkText(text) : [];
    const shown = chunks.slice(0, MAX_REPLY_MESSAGES);
    const first = shown.length ? `${header}\n\n${shown[0]}` : `${header}\n\n（文字は読み取れませんでした）`;
    const firstChunks = first.length > 2000 ? [header, shown[0]] : [first];
    const rest = [...firstChunks.slice(1), ...shown.slice(1)];
    if (chunks.length > MAX_REPLY_MESSAGES) rest.push('…（続きはドライブのファイルの「説明」欄にあります）');
    await reply(env, msg, firstChunks[0]);
    for (const c of rest) await reply(env, msg, c, false);

    await setStatus(env, att.id, 'done');
    await markSaved(env, msg.channel_id).catch((e) => console.error('otayori tag failed', msg.channel_id, e));
  } catch (e) {
    console.error('otayori failed', att.id, e);
    const message = e instanceof Error ? e.message : String(e);
    await setStatus(env, att.id, 'error', message.slice(0, 500));
    // 設定の問題（許可切れ・API が無効・権限不足）は、管理者が直せば自動でやり直せるよう、失敗回数に数えない
    const setupProblem =
      e instanceof GoogleAuthError ||
      (e instanceof GoogleApiError && e.status === 403 && /SERVICE_DISABLED|accessNotConfigured|insufficient|SCOPE/i.test(e.message));
    if (setupProblem) {
      await env.DB.prepare('UPDATE otayori_files SET attempts = attempts - 1 WHERE attachment_id = ?').bind(att.id).run();
      return;
    }
    if (attempts >= MAX_ATTEMPTS) {
      await reply(env, msg, `⚠️ 「${att.filename}」の読み取りに失敗しました。お手数ですが、もう一度投稿してください。`).catch(() => {});
    }
  }
}
