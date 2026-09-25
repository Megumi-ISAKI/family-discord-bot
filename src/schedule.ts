// メンバーごとの予定を取得して Discord の埋め込み（embed）に整形する
// 自動投稿・/今日の予定・/質問（予定の質問）で同じ表示を使う

import type { CalendarReg, Env, Member, ScheduleItem } from './types';
import { GoogleAuthError, isSubCalendarId, listGoogleItemsBetween, type RangeItem } from './google';
import { fetchIcs, icsItemsFromParsed, parseIcs } from './ics';
import { addDays, compareYMD, dayRange, formatDayLabel, formatHM, todayYMD, ymdString, type YMD } from './time';

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string }[];
  footer?: { text: string };
}

const COLOR = 0x4285f4;
const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_EMBED_CHARS = 5800; // 1メッセージの埋め込みの合計上限 6000 に少し余裕を持たせる
const MAX_EMBEDS_PER_MESSAGE = 10;

type CalendarResult = { cal: CalendarReg; items?: RangeItem[]; error?: unknown };

/** 1つのカレンダーの、first〜last（日本時間の日付）の予定をまとめて取得する（カレンダーごとに1回の通信） */
async function fetchCalendarRange(env: Env, c: CalendarReg, first: YMD, last: YMD): Promise<RangeItem[]> {
  const tz = env.TIMEZONE;
  if (c.kind === 'google') {
    return listGoogleItemsBetween(env, c.source, dayRange(first, tz).start, dayRange(last, tz).end, tz);
  }
  const parsed = parseIcs(await fetchIcs(c.source));
  const items: RangeItem[] = [];
  for (let day = first; compareYMD(day, last) <= 0; day = addDays(day, 1)) {
    for (const it of icsItemsFromParsed(parsed, day, tz)) {
      items.push(it.allDay ? { ...it, startDate: ymdString(day), endDate: ymdString(addDays(day, 1)) } : it);
    }
  }
  return items;
}

async function fetchMemberRange(env: Env, member: Member, first: YMD, last: YMD): Promise<CalendarResult[]> {
  return Promise.all(
    member.calendars.map((cal) =>
      fetchCalendarRange(env, cal, first, last).then(
        (items) => ({ cal, items }),
        (error) => ({ cal, error }),
      ),
    ),
  );
}

/** 期間の予定のうち、その日にかかるもの */
function itemsOnDay(items: RangeItem[], day: YMD, tz: string): ScheduleItem[] {
  const { start: dayStart, end: dayEnd } = dayRange(day, tz);
  const d = ymdString(day);
  return items.filter((it) => {
    if (it.allDay) {
      const s = it.startDate ?? d;
      const e = it.endDate && it.endDate > s ? it.endDate : ymdString(addDays(parseYmd(s), 1));
      return s <= d && d < e;
    }
    if (!it.start || !it.end) return false;
    return it.start < dayEnd && (it.end > dayStart || (it.end.getTime() === it.start.getTime() && it.start >= dayStart));
  });
}

function parseYmd(s: string): YMD {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** 予定に［カレンダー名］を付けるか。複数登録している人のサブカレンダー・iCal のみ付ける */
function needsLabel(member: Member, c: CalendarReg): boolean {
  return member.calendars.length > 1 && (c.kind === 'ics' || isSubCalendarId(c.source));
}

/** 1人分・1日分の予定（登録カレンダーすべて）をまとめて文章にする */
function memberDayText(member: Member, results: CalendarResult[], day: YMD, tz: string): string {
  const items: ScheduleItem[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const { cal, items: calItems, error } of results) {
    if (error !== undefined) {
      if (error instanceof GoogleAuthError) throw error;
      warnings.push(`⚠️ ${member.calendars.length > 1 ? `［${cal.label}］` : ''}取得できませんでした（共有設定や URL を確認してください）`);
      continue;
    }
    for (const it of itemsOnDay(calItems!, day, tz)) {
      // 同じ予定が複数のカレンダーに入っている場合は1つにまとめる
      const key = `${it.title}|${it.allDay}|${it.start?.getTime()}|${it.end?.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(needsLabel(member, cal) ? { ...it, calendar: cal.label } : it);
    }
  }
  if (items.length === 0 && warnings.length > 0) return warnings.join('\n');
  const text = formatItems(items, day, tz);
  return warnings.length ? `${text}\n${warnings.join('\n')}`.slice(0, MAX_FIELD_VALUE) : text;
}

export function formatItems(items: ScheduleItem[], day: YMD, tz: string): string {
  if (items.length === 0) return '予定なし';
  const { start: dayStart, end: dayEnd } = dayRange(day, tz);
  const sorted = [...items].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0);
  });

  const lines = sorted.map((it) => {
    let time = '終日';
    if (!it.allDay && it.start && it.end) {
      const s = it.start < dayStart ? '' : formatHM(it.start, tz);
      const e = it.end > dayEnd ? '' : formatHM(it.end, tz);
      time = it.start.getTime() === it.end.getTime() ? s : `${s}〜${e}`;
    }
    const loc = it.location ? `（📍${it.location.split('\n')[0]}）` : '';
    const calendar = it.calendar ? `［${it.calendar}］` : '';
    return `\`${time}\` ${it.title}${calendar}${loc}`;
  });

  let out = '';
  for (const [i, line] of lines.entries()) {
    const rest = `\n…ほか${lines.length - i}件`;
    if (out.length + line.length + 1 + rest.length > MAX_FIELD_VALUE) return out + rest;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

/** 見出し：「📅 今日 9/25（金） の予定」「🌙 明日 9/26（土） の予定」「📅 9/28（月） の予定」 */
function dayTitle(env: Env, day: YMD, now: Date): string {
  const today = todayYMD(env.TIMEZONE, now);
  const relative = compareYMD(day, today) === 0 ? '今日 ' : compareYMD(day, addDays(today, 1)) === 0 ? '明日 ' : '';
  const icon = relative === '明日 ' ? '🌙' : '📅';
  return `${icon} ${relative}${formatDayLabel(day)} の予定`;
}

/** 1日分の埋め込み（項目数・文字数が多いときは複数に分ける） */
function dayEmbeds(title: string, fields: { name: string; value: string }[]): Embed[] {
  if (fields.length === 0) {
    return [{ title, description: '登録されているメンバーがいません。`/カレンダー登録` で登録できます。', color: COLOR }];
  }
  const embeds: Embed[] = [];
  let embed: Embed = { title, color: COLOR, fields: [] };
  let chars = title.length;
  for (const f of fields) {
    const size = f.name.length + f.value.length;
    if (embed.fields!.length >= MAX_FIELDS || chars + size > MAX_EMBED_CHARS) {
      embeds.push(embed);
      embed = { title: `${title}（続き）`, color: COLOR, fields: [] };
      chars = embed.title!.length;
    }
    embed.fields!.push(f);
    chars += size;
  }
  embeds.push(embed);
  return embeds;
}

const embedSize = (e: Embed) =>
  (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/** 埋め込みを、1メッセージの上限（10個・合計約6000文字）に収まるようにまとめる */
export function groupEmbeds(embeds: Embed[]): Embed[][] {
  const messages: Embed[][] = [];
  let current: Embed[] = [];
  let chars = 0;
  for (const e of embeds) {
    const size = embedSize(e);
    if (current.length && (current.length >= MAX_EMBEDS_PER_MESSAGE || chars + size > MAX_EMBED_CHARS)) {
      messages.push(current);
      current = [];
      chars = 0;
    }
    current.push(e);
    chars += size;
  }
  if (current.length) messages.push(current);
  return messages;
}

/**
 * 指定した日（複数可）の、メンバー全員分の予定の埋め込みを作る。1日につき1つ（多いときは複数）
 * now：見出しの「今日」「明日」を判断する基準の時刻（自動投稿では実行予定時刻）
 */
export async function buildScheduleEmbeds(env: Env, members: Member[], days: YMD[], now = new Date()): Promise<Embed[]> {
  if (days.length === 0) return [];
  const tz = env.TIMEZONE;
  const first = days[0];
  const last = days[days.length - 1];
  const perMember = await Promise.all(members.map((m) => fetchMemberRange(env, m, first, last)));

  return days.flatMap((day) => {
    const fields = members.map((m, i) => {
      let value: string;
      try {
        value = memberDayText(m, perMember[i], day, tz);
      } catch (e) {
        console.error(`schedule failed for ${m.user_id}:`, e);
        value =
          e instanceof GoogleAuthError
            ? '⚠️ Bot の Google アカウントへのアクセス許可が切れています（管理者は `npm run google-login` を実行してください）'
            : '⚠️ 取得できませんでした';
      }
      return { name: `👤 ${m.display_name}`, value };
    });
    return dayEmbeds(dayTitle(env, day, now), fields);
  });
}

/** 1日分の予定を、送信するメッセージごとの埋め込みのまとまりで返す（自動投稿・/今日の予定） */
export async function buildScheduleMessages(env: Env, members: Member[], day: YMD, now = new Date()): Promise<Embed[][]> {
  return groupEmbeds(await buildScheduleEmbeds(env, members, [day], now));
}
