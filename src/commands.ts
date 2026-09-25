// スラッシュコマンド・選択メニュー・入力候補の処理本体

import type { CalendarReg, Env, Member } from './types';
import {
  EPHEMERAL,
  displayName,
  editOriginal,
  focusedOption,
  followup,
  getOption,
  selectMenu,
  type Interaction,
  type MessageBody,
  type SelectOption,
} from './discord';
import {
  GoogleApiError,
  GoogleAuthError,
  botEmail,
  insertEvent,
  isSubCalendarId,
  listSharedCalendars,
  subscribeCalendar,
  type CalendarInfo,
  type NewEvent,
} from './google';
import { deleteCalendars, getMemberCalendars, listMembers, registeredSources, upsertCalendar, upsertMember } from './db';
import { fetchIcs, icsItemsForDay, normalizeIcsUrl } from './ics';
import { buildScheduleEmbeds, buildScheduleMessages, groupEmbeds } from './schedule';
import { ConciergeLimitError, askConcierge } from './concierge';
import { chunkText } from './otayori';
import { addDays, addMinutes, formatDayLabel, localDateTimeString, parseDate, parseTime, todayYMD, ymdString } from './time';

const ROLE_LABEL: Record<string, string> = {
  owner: 'オーナー（予定の追加もできます）',
  writer: '予定の変更（予定の追加もできます）',
  reader: '予定の表示（`/予定追加` は使えません）',
  freeBusyReader: '空き時間情報のみ（自動投稿には「予定あり」とだけ表示されます）',
  ics: 'iCal URL（閲覧のみ）',
};

const ROLE_SHORT: Record<string, string> = {
  owner: '予定の変更',
  writer: '予定の変更',
  reader: '予定の表示',
  freeBusyReader: '空き時間のみ',
};

const canWrite = (c: CalendarReg) => c.kind === 'google' && (c.access_role === 'owner' || c.access_role === 'writer');

type Reply = (body: string | MessageBody) => Promise<void>;

function makeReply(env: Env, i: Interaction): Reply {
  return (body) =>
    editOriginal(env.DISCORD_APPLICATION_ID, i.token, typeof body === 'string' ? { content: body, components: [] } : body);
}

async function withErrors(reply: Reply, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(e);
    if (e instanceof GoogleAuthError) {
      return reply('⚠️ Bot の Google アカウントへのアクセス許可が切れています。管理者に連絡してください。');
    }
    await reply('⚠️ エラーが発生しました。時間をおいてもう一度お試しください。');
  }
}

/** スラッシュコマンド（「考え中…」を返したあとに実行し、結果で差し替える） */
export async function handleCommand(env: Env, i: Interaction): Promise<void> {
  const reply = makeReply(env, i);
  await withErrors(reply, async () => {
    switch (i.data?.name) {
      case 'カレンダー登録':
        return register(env, i, reply);
      case 'カレンダー解除':
        return unregister(env, i, reply);
      case '今日の予定':
        return showSchedule(env, i, reply);
      case '予定追加':
        return addEvent(env, i, reply);
      case '質問':
        return askQuestion(env, i, reply);
      default:
        return reply('不明なコマンドです。');
    }
  });
}

/** 選択メニューが選ばれたとき（メニューのあるメッセージを結果で差し替える） */
export async function handleComponent(env: Env, i: Interaction): Promise<void> {
  const reply = makeReply(env, i);
  await withErrors(reply, async () => {
    switch (i.data?.custom_id) {
      case 'register-select':
        return registerSelected(env, i, reply);
      case 'unregister-select':
        return unregisterSelected(env, i, reply);
    }
  });
}

/** 入力候補（`/予定追加` の「カレンダー」欄）。3秒以内に返す必要があるので、DB だけを見る */
export async function autocompleteChoices(env: Env, i: Interaction): Promise<{ name: string; value: string }[]> {
  const focused = focusedOption(i);
  if (i.data?.name !== '予定追加' || focused?.name !== 'カレンダー') return [];
  const typed = String(focused.value ?? '').trim();
  const mine = (await getMemberCalendars(env, i.member!.user.id)).filter(canWrite);
  return mine
    .filter((c) => !typed || c.label.includes(typed))
    .slice(0, 25)
    .map((c) => ({ name: c.label.slice(0, 100), value: String(c.id) }));
}

// ───────────── カレンダー登録 ─────────────

function registrationGuide(env: Env): string {
  const bot = botEmail(env);
  return [
    '## 📅 カレンダー登録',
    `Bot は家族アカウント \`${bot}\` に共有されたカレンダーを読み取ります。`,
    '',
    '**まだ共有していないカレンダーがある場合**',
    '1. パソコンで Google カレンダーを開き、右上の ⚙️ →「設定」',
    '2. 左の「マイカレンダーの設定」から、共有したいカレンダーを選ぶ（メイン以外のカレンダーも可）',
    `3. 「特定のユーザーまたはグループと共有する」に \`${bot}\` を追加`,
    '4. 権限を選んで「送信」',
    '　・予定の追加もしたい →「予定の変更」',
    '　・見せるだけでいい →「すべての予定の詳細を表示」',
    '　・中身は隠したい →「予定の表示（時間枠のみ、詳細は非表示）」',
    '5. もう一度 `/カレンダー登録` を実行すると、下のメニューに表示されます',
    '',
    '**Google 以外（iCloud・Outlook など）の場合**',
    'カレンダーの「公開 URL / iCal URL」をコピーして `/カレンダー登録 アドレス:URL` を実行してください（閲覧のみ）。',
  ].join('\n');
}

function registeredList(calendars: CalendarReg[]): string {
  if (calendars.length === 0) return '（まだありません）';
  return calendars
    .map((c) => {
      const role = c.kind === 'ics' ? 'iCal・閲覧のみ' : ROLE_SHORT[c.access_role ?? ''];
      return `・${c.label}${role ? `（${role}）` : ''}`;
    })
    .join('\n');
}

/** メニューに出す候補：家族アカウントに共有されていて、他の人が登録していないカレンダー */
async function candidateCalendars(env: Env, userId: string): Promise<CalendarInfo[]> {
  const [shared, taken] = await Promise.all([listSharedCalendars(env), registeredSources(env)]);
  return shared.filter((c) => !taken.has(c.id) || taken.get(c.id) === userId);
}

async function register(env: Env, i: Interaction, reply: Reply) {
  const input = getOption(i, 'アドレス')?.trim();
  const userId = i.member!.user.id;
  if (input) return registerByAddress(env, i, input, reply);

  const [mine, candidates] = await Promise.all([getMemberCalendars(env, userId), candidateCalendars(env, userId)]);
  const mineSources = new Set(mine.map((c) => c.source));

  const content = [
    registrationGuide(env),
    '',
    '**あなたが登録中のカレンダー**',
    registeredList(mine),
    '',
    candidates.length
      ? '👇 **下のメニューから、自分のカレンダーをすべて選んでください**（複数選択できます。選ばなかったカレンダーは登録から外れます）'
      : '家族アカウントに共有されているカレンダーが見つかりませんでした。上の手順で共有してから、もう一度実行してください。',
    candidates.length > 25 ? '-# 候補が多いため、先頭の25件だけを表示しています。' : '',
  ].join('\n');

  const options: SelectOption[] = candidates.map((c) => ({
    label: c.summary,
    value: c.id,
    description: `${ROLE_SHORT[c.accessRole] ?? c.accessRole}・${c.id}`,
    default: mineSources.has(c.id),
  }));

  return reply({
    content,
    components: options.length ? [selectMenu('register-select', '自分のカレンダーを選ぶ', options)] : [],
  });
}

async function registerSelected(env: Env, i: Interaction, reply: Reply) {
  const userId = i.member!.user.id;
  const selected = new Set(i.data?.values ?? []);
  const candidates = await candidateCalendars(env, userId);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  await upsertMember(env, userId, displayName(i));
  const skipped: string[] = [];
  for (const id of selected) {
    const c = byId.get(id);
    if (!c) {
      skipped.push(id); // 選んでいる間に他の人が登録した、または共有が外れた
      continue;
    }
    await upsertCalendar(env, { user_id: userId, kind: 'google', source: c.id, label: c.summary, access_role: c.accessRole });
  }

  // メニューに出ていたのに選ばれなかったカレンダーは登録から外す（アドレス指定・iCal で登録したものは残す）
  const mine = await getMemberCalendars(env, userId);
  await deleteCalendars(
    env,
    userId,
    mine.filter((c) => c.kind === 'google' && byId.has(c.source) && !selected.has(c.source)).map((c) => c.id),
  );

  const now = await getMemberCalendars(env, userId);
  return reply(
    [
      '✅ 登録を更新しました。次の自動投稿（毎朝7:00・毎晩20:00）から予定が表示されます。',
      '',
      '**登録中のカレンダー**',
      registeredList(now),
      skipped.length ? `\n⚠️ ${skipped.length} 件は登録できませんでした（他の人がすでに登録しているか、共有が外れています）。` : '',
    ].join('\n'),
  );
}

async function registerByAddress(env: Env, i: Interaction, input: string, reply: Reply) {
  const userId = i.member!.user.id;

  if (/^(https?|webcal):\/\//i.test(input)) {
    const url = normalizeIcsUrl(input);
    try {
      icsItemsForDay(await fetchIcs(url), todayYMD(env.TIMEZONE), env.TIMEZONE);
    } catch (e) {
      return reply(`⚠️ この URL からカレンダーを読み込めませんでした。\n${(e as Error).message}`);
    }
    await upsertMember(env, userId, displayName(i));
    await upsertCalendar(env, { user_id: userId, kind: 'ics', source: url, label: 'iCal', access_role: 'ics' });
    return reply(
      `✅ 登録しました（iCal URL・閲覧のみ）。\n\n**登録中のカレンダー**\n${registeredList(await getMemberCalendars(env, userId))}\n-# URL は他の人には表示されません。`,
    );
  }

  if (!/^[^\s@]+@[^\s@]+$/.test(input)) {
    return reply('⚠️ Gmail アドレス（カレンダーID）か、カレンダーの URL を入力してください。\nアドレスなしで `/カレンダー登録` を実行すると、メニューから選べます。');
  }

  let info: CalendarInfo;
  try {
    info = await subscribeCalendar(env, input);
  } catch (e) {
    if (e instanceof GoogleApiError && (e.status === 403 || e.status === 404)) {
      return reply(
        `⚠️ \`${input}\` のカレンダーにアクセスできませんでした。\n共有がまだ済んでいないか、アドレスが違う可能性があります。共有してから数分待って再度お試しください。\n\n${registrationGuide(env)}`,
      );
    }
    throw e;
  }

  await upsertMember(env, userId, displayName(i));
  await upsertCalendar(env, { user_id: userId, kind: 'google', source: info.id, label: info.summary, access_role: info.accessRole });
  return reply(
    `✅ 登録しました。\n権限：${ROLE_LABEL[info.accessRole] ?? info.accessRole}\n\n**登録中のカレンダー**\n${registeredList(await getMemberCalendars(env, userId))}`,
  );
}

// ───────────── カレンダー解除 ─────────────

async function unregister(env: Env, i: Interaction, reply: Reply) {
  const userId = i.member!.user.id;
  const mine = await getMemberCalendars(env, userId);
  if (mine.length === 0) return reply('カレンダーは登録されていません。');
  if (mine.length === 1) {
    await deleteCalendars(env, userId, [mine[0].id]);
    return reply(unregisteredMessage(env, mine));
  }
  return reply({
    content: '解除するカレンダーを選んでください（複数選択できます）。',
    components: [
      selectMenu(
        'unregister-select',
        '解除するカレンダーを選ぶ',
        mine.map((c) => ({ label: c.label, value: String(c.id), description: c.kind === 'ics' ? 'iCal URL' : c.source })),
      ),
    ],
  });
}

async function unregisterSelected(env: Env, i: Interaction, reply: Reply) {
  const userId = i.member!.user.id;
  const ids = new Set((i.data?.values ?? []).map(Number));
  const mine = await getMemberCalendars(env, userId);
  const targets = mine.filter((c) => ids.has(c.id));
  await deleteCalendars(env, userId, targets.map((c) => c.id));
  const rest = mine.filter((c) => !ids.has(c.id));
  return reply(
    unregisteredMessage(env, targets) + (rest.length ? `\n\n**登録中のカレンダー**\n${registeredList(rest)}` : '\n自動投稿から外れました。'),
  );
}

function unregisteredMessage(env: Env, removed: CalendarReg[]): string {
  // 家族アカウント側のカレンダー一覧や共有には触れない（Google カレンダーで見る用途を妨げないため）
  return (
    `✅ 登録を解除しました：${removed.map((c) => c.label).join('、')}` +
    (removed.some((c) => c.kind === 'google')
      ? `\n家族アカウント（${botEmail(env)}）への共有もやめたい場合は、Google カレンダーの設定画面から削除してください。`
      : '')
  );
}

// ───────────── 今日の予定 ─────────────

async function showSchedule(env: Env, i: Interaction, reply: Reply) {
  const dateInput = getOption(i, '日付');
  const day = dateInput ? parseDate(dateInput, env.TIMEZONE) : todayYMD(env.TIMEZONE);
  if (!day) return reply('⚠️ 日付が読み取れませんでした。「明日」「9/25」「2026-09-25」のように入力してください。');

  const targetId = getOption(i, 'メンバー');
  let members: Member[] = await listMembers(env);
  if (targetId) {
    members = members.filter((m) => m.user_id === targetId);
    if (members.length === 0) return reply('そのメンバーはカレンダーを登録していません。');
  }

  const [first, ...rest] = await buildScheduleMessages(env, members, day);
  await reply({ content: '', embeds: first, components: [] });
  for (const embeds of rest) await followup(env.DISCORD_APPLICATION_ID, i.token, { embeds, flags: EPHEMERAL });
}

// ───────────── 質問（AIコンシェルジュ） ─────────────

/** `/質問` は `自分だけ` を指定しない限りチャンネルの全員に見える */
export function isPublicQuestion(i: Interaction): boolean {
  return i.data?.name === '質問' && getOption<boolean>(i, '自分だけ') !== true;
}

async function askQuestion(env: Env, i: Interaction, reply: Reply) {
  const question = getOption(i, '内容')!.trim();
  const name = displayName(i);
  let result;
  try {
    result = await askConcierge(env, { id: i.member!.user.id, name }, question);
  } catch (e) {
    if (e instanceof ConciergeLimitError) return reply(`⚠️ ${e.message}`);
    throw e;
  }

  const quoted = question.length > 200 ? question.slice(0, 200) + '…' : question;
  const header = `💬 **${name}** さんの質問：${quoted}`;
  const warning = result.warning ? `\n-# ⚠️ ${result.warning}` : '';
  const flags = isPublicQuestion(i) ? 0 : EPHEMERAL;

  // 予定の一覧：#📅-家族の予定 と同じ表示
  if (result.kind === 'schedule') {
    const messages = groupEmbeds(await buildScheduleEmbeds(env, result.members, result.days));
    await reply({ content: `${header}\n\n${result.intro}${warning}`, embeds: messages[0] ?? [], components: [] });
    for (const embeds of messages.slice(1)) await followup(env.DISCORD_APPLICATION_ID, i.token, { embeds, flags });
    return;
  }

  // 通常の回答。おたよりを根拠にした場合は、スレッドとドライブへのリンクを添える
  const sources = result.sources.length
    ? '\n\n📎 **出典**\n' +
      result.sources
        .map((s) => `・${s.title}（${s.posted}投稿）｜[スレッド](<${s.threadUrl}>)｜[ドライブ](<${s.driveUrl}>)`)
        .join('\n')
    : '';
  const [first, ...rest] = chunkText(`${header}\n\n${result.answer}${sources}${warning}`);
  await reply(first);
  for (const c of rest) await followup(env.DISCORD_APPLICATION_ID, i.token, { content: c, flags });
}

// ───────────── 予定追加 ─────────────

/** 追加先の既定：予定の変更ができるカレンダーのうち、メインカレンダー（ID がメールアドレス）を優先 */
function defaultTarget(calendars: CalendarReg[]): CalendarReg | undefined {
  const writable = calendars.filter(canWrite);
  return writable.find((c) => !isSubCalendarId(c.source)) ?? writable[0] ?? calendars.find((c) => c.kind === 'google');
}

async function addEvent(env: Env, i: Interaction, reply: Reply) {
  const mine = await getMemberCalendars(env, i.member!.user.id);
  if (mine.length === 0) return reply('先に `/カレンダー登録` でカレンダーを登録してください。');

  const chosen = getOption(i, 'カレンダー');
  const target = chosen ? mine.find((c) => String(c.id) === chosen || c.label === chosen) : defaultTarget(mine);
  if (!target) {
    return reply(
      chosen
        ? '⚠️ そのカレンダーは見つかりませんでした。「カレンダー」欄は候補から選んでください。'
        : 'iCal URL で登録したカレンダーには予定を追加できません。Google カレンダーを共有して登録してください。',
    );
  }
  if (target.kind !== 'google') return reply('iCal URL で登録したカレンダーには予定を追加できません。');

  const tz = env.TIMEZONE;
  const title = getOption(i, 'タイトル')!.trim();
  const day = parseDate(getOption(i, '日付')!, tz);
  if (!day) return reply('⚠️ 日付が読み取れませんでした。「明日」「9/25」「2026-09-25」のように入力してください。');

  const startInput = getOption(i, '開始');
  const endInput = getOption(i, '終了');
  const location = getOption(i, '場所')?.trim() || undefined;

  let event: NewEvent;
  let label: string;
  if (!startInput) {
    if (endInput) return reply('⚠️ 終了時刻を指定するときは開始時刻も入力してください。');
    event = { summary: title, location, start: { date: ymdString(day) }, end: { date: ymdString(addDays(day, 1)) } };
    label = `${formatDayLabel(day)} 終日`;
  } else {
    const start = parseTime(startInput);
    if (!start) return reply('⚠️ 開始時刻が読み取れませんでした。「15:00」「15時半」のように入力してください。');
    let end = addMinutes(day, start, 60);
    if (endInput) {
      const e = parseTime(endInput);
      if (!e) return reply('⚠️ 終了時刻が読み取れませんでした。「16:00」のように入力してください。');
      // 終了が開始より前なら日付をまたぐ予定とみなす
      const crosses = e.h * 60 + e.m <= start.h * 60 + start.m;
      end = { ymd: crosses ? addDays(day, 1) : day, hm: e };
    }
    event = {
      summary: title,
      location,
      start: { dateTime: localDateTimeString(day, start), timeZone: tz },
      end: { dateTime: localDateTimeString(end.ymd, end.hm), timeZone: tz },
    };
    const hm = (x: { h: number; m: number }) => `${x.h}:${String(x.m).padStart(2, '0')}`;
    label = `${formatDayLabel(day)} ${hm(start)}〜${hm(end.hm)}`;
  }

  try {
    const created = await insertEvent(env, target.source, event);
    const where = mine.length > 1 ? `\n追加先：${target.label}` : '';
    return reply(
      `✅ 予定を追加しました\n**${title}**　${label}${location ? `　📍${location}` : ''}${where}\n[Google カレンダーで開く](<${created.htmlLink}>)`,
    );
  } catch (e) {
    if (e instanceof GoogleApiError && (e.status === 403 || e.status === 404)) {
      return reply(
        `⚠️ 「${target.label}」に予定を追加する権限がありません。Google カレンダーの共有設定で、権限を「予定の変更」にしてください。`,
      );
    }
    throw e;
  }
}
