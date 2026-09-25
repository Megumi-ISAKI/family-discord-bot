// 日付・時刻ユーティリティ（Workers の実行環境は UTC なので、タイムゾーンは常に明示して扱う）

export type YMD = { y: number; m: number; d: number };
export type HM = { h: number; m: number };

const pad = (n: number) => String(n).padStart(2, '0');

function zonedParts(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

export function todayYMD(tz: string, now = new Date()): YMD {
  const p = zonedParts(tz, now);
  return { y: p.y, m: p.m, d: p.d };
}

/** 自動投稿の対象日：日本時間（tz）の正午より前なら今日、正午以降なら明日 */
export function scheduledTargetDay(at: Date, tz: string): YMD {
  const today = todayYMD(tz, at);
  return zonedParts(tz, at).h < 12 ? today : addDays(today, 1);
}

export function addDays(ymd: YMD, n: number): YMD {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function compareYMD(a: YMD, b: YMD): number {
  return ymdString(a).localeCompare(ymdString(b));
}

export function ymdString(ymd: YMD): string {
  return `${ymd.y}-${pad(ymd.m)}-${pad(ymd.d)}`;
}

export function localDateTimeString(ymd: YMD, hm: HM): string {
  return `${ymdString(ymd)}T${pad(hm.h)}:${pad(hm.m)}:00`;
}

function tzOffsetMinutes(tz: string, at: Date): number {
  const p = zonedParts(tz, at);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - at.getTime()) / 60000;
}

/** タイムゾーン tz における壁時計の日時を、実際の時刻（Date）に変換する */
export function zonedToInstant(ymd: YMD, hm: HM, tz: string): Date {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hm.h, hm.m);
  const off = tzOffsetMinutes(tz, new Date(guess));
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(t));
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

export function dayRange(ymd: YMD, tz: string): { start: Date; end: Date } {
  return {
    start: zonedToInstant(ymd, { h: 0, m: 0 }, tz),
    end: zonedToInstant(addDays(ymd, 1), { h: 0, m: 0 }, tz),
  };
}

export function formatHM(date: Date, tz: string): string {
  const p = zonedParts(tz, date);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function formatDayLabel(ymd: YMD): string {
  const wd = WEEKDAYS[new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay()];
  return `${ymd.m}/${ymd.d}（${wd}）`;
}

function isValidYMD(ymd: YMD): boolean {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  return t.getUTCFullYear() === ymd.y && t.getUTCMonth() + 1 === ymd.m && t.getUTCDate() === ymd.d;
}

/** 「今日」「明日」「9/25」「9月25日」「2026-09-25」などを解釈する */
export function parseDate(input: string, tz: string, now = new Date()): YMD | null {
  const s = input.normalize('NFKC').trim();
  const today = todayYMD(tz, now);

  if (/^(今日|きょう)$/.test(s)) return today;
  if (/^(明日|あした|あす)$/.test(s)) return addDays(today, 1);
  if (/^(明後日|あさって)$/.test(s)) return addDays(today, 2);

  let m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
  if (m) {
    const ymd = { y: +m[1], m: +m[2], d: +m[3] };
    return isValidYMD(ymd) ? ymd : null;
  }

  m = s.match(/^(\d{1,2})[-/月](\d{1,2})日?$/);
  if (m) {
    let ymd = { y: today.y, m: +m[1], d: +m[2] };
    // 年を省略して過去の日付になる場合は来年とみなす
    if (isValidYMD(ymd) && compareYMD(ymd, today) < 0) ymd = { ...ymd, y: today.y + 1 };
    return isValidYMD(ymd) ? ymd : null;
  }

  return null;
}

/** 「15:00」「15時」「15時30分」「15時半」「1500」などを解釈する */
export function parseTime(input: string): HM | null {
  const s = input.normalize('NFKC').trim();
  let h: number;
  let mi = 0;

  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    h = +m[1];
    mi = +m[2];
  } else if ((m = s.match(/^(\d{1,2})時(?:(\d{1,2})分?|(半))?$/))) {
    h = +m[1];
    mi = m[3] ? 30 : m[2] ? +m[2] : 0;
  } else if ((m = s.match(/^(\d{1,2})(\d{2})$/))) {
    h = +m[1];
    mi = +m[2];
  } else {
    return null;
  }

  return h <= 23 && mi <= 59 ? { h, m: mi } : null;
}

export function addMinutes(ymd: YMD, hm: HM, minutes: number): { ymd: YMD; hm: HM } {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, hm.h, hm.m + minutes));
  return {
    ymd: { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() },
    hm: { h: t.getUTCHours(), m: t.getUTCMinutes() },
  };
}
