// iCal（ICS）URL からの予定取得。Google 以外のカレンダーや、閲覧だけ共有したい人向け。

import ICAL from 'ical.js';
import type { ScheduleItem } from './types';
import { dayRange, ymdString, type YMD } from './time';

/** 無限ループ防止：1つの繰り返し予定について調べる回数の上限 */
const MAX_OCCURRENCES = 20000;

export function normalizeIcsUrl(input: string): string {
  return input.trim().replace(/^webcal:\/\//i, 'https://');
}

export async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`ICS の取得に失敗しました (HTTP ${res.status})`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('カレンダー形式（ICS）のデータではありません');
  return text;
}

export interface ParsedIcs {
  events: ICAL.Event[];
}

/** ICS を一度だけ解析する（複数日を調べるときに使い回す） */
export function parseIcs(icsText: string): ParsedIcs {
  const root = new ICAL.Component(ICAL.parse(icsText));
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(vtz);
  }

  // 繰り返し予定の「この回だけ変更」を本体に関連付ける
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    if (vevent.getFirstPropertyValue('status') === 'CANCELLED') continue;
    const ev = new ICAL.Event(vevent);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  const standalone: ICAL.Event[] = [];
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else standalone.push(ex);
  }
  return { events: [...masters.values(), ...standalone] };
}

export function icsItemsForDay(icsText: string, day: YMD, tz: string): ScheduleItem[] {
  return icsItemsFromParsed(parseIcs(icsText), day, tz);
}

export function icsItemsFromParsed(parsed: ParsedIcs, day: YMD, tz: string): ScheduleItem[] {
  const { start: dayStart, end: dayEnd } = dayRange(day, tz);
  const today = ymdString(day);
  const items: ScheduleItem[] = [];

  const collect = (ev: ICAL.Event, startDate: ICAL.Time, endDate: ICAL.Time) => {
    const title = ev.summary?.trim() || '予定あり';
    const location = ev.location || undefined;
    if (startDate.isDate) {
      // 終日予定は日付の文字列で判定する（時差の影響を受けないように）
      const s = startDate.toString();
      const e = endDate ? endDate.toString() : s;
      const inRange = e > s ? s <= today && today < e : s === today;
      if (inRange) items.push({ title, allDay: true, location });
      return;
    }
    const s = startDate.toJSDate();
    const e = endDate ? endDate.toJSDate() : s;
    if (s < dayEnd && (e > dayStart || (e.getTime() === s.getTime() && s >= dayStart))) {
      items.push({ title, allDay: false, start: s, end: e, location });
    }
  };

  for (const ev of parsed.events) {
    if (!ev.isRecurring()) {
      collect(ev, ev.startDate, ev.endDate);
      continue;
    }
    const it = ev.iterator();
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const next = it.next();
      if (!next) break;
      const details = ev.getOccurrenceDetails(next);
      const occStart = details.startDate;
      if (occStart.isDate ? occStart.toString() > today : occStart.toJSDate() >= dayEnd) break;
      if (details.item.component.getFirstPropertyValue('status') === 'CANCELLED') continue;
      collect(details.item, occStart, details.endDate);
    }
  }
  return items;
}
