// Google Calendar API（家族アカウントとしてアクセスする）

import type { Env, ScheduleItem } from './types';

const API = 'https://www.googleapis.com/calendar/v3';

export class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 家族アカウント側で Bot の許可が取り消された・期限切れになったとき */
export class GoogleAuthError extends Error {}

export function botEmail(env: Env): string {
  return env.BOT_GOOGLE_EMAIL;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes('invalid_grant')) {
      throw new GoogleAuthError('家族アカウントの許可が取り消されたか期限切れです。npm run google-login でログインし直してください。');
    }
    throw new GoogleApiError(res.status, `トークン取得に失敗: ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

/** 家族アカウントとして Google API を呼ぶ（Drive など Calendar 以外の API 用） */
export async function googleFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken(env);
  return fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
}

async function gapi<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken(env);
  const res = await fetch(API + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new GoogleApiError(res.status, await res.text());
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const cal = (id: string) => encodeURIComponent(id);

export interface CalendarInfo {
  id: string;
  summary: string;
  accessRole: string;
}

interface CalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  accessRole: string;
  primary?: boolean;
}

const toInfo = (e: CalendarListEntry): CalendarInfo => ({
  id: e.id,
  summary: e.summaryOverride || e.summary || e.id,
  accessRole: e.accessRole,
});

/**
 * 共有されたカレンダーを家族アカウントのカレンダー一覧に追加し（追加済みならそのまま）、名前と権限を返す。
 * 権限: owner / writer / reader / freeBusyReader
 */
export async function subscribeCalendar(env: Env, calendarId: string): Promise<CalendarInfo> {
  try {
    await gapi(env, '/users/me/calendarList', { method: 'POST', body: JSON.stringify({ id: calendarId }) });
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.status === 409)) throw e; // 409 = 登録済み
  }
  return toInfo(await gapi<CalendarListEntry>(env, `/users/me/calendarList/${cal(calendarId)}`));
}

/**
 * 家族アカウントのカレンダー一覧のうち、家族から共有されたもの（登録の候補）を返す。
 * 家族アカウント自身のメインカレンダーと、祝日・誕生日などの購読カレンダーは除く。
 */
export async function listSharedCalendars(env: Env): Promise<CalendarInfo[]> {
  const entries: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ minAccessRole: 'freeBusyReader', showHidden: 'true', maxResults: '250' });
    if (pageToken) qs.set('pageToken', pageToken);
    const res = await gapi<{ items?: CalendarListEntry[]; nextPageToken?: string }>(env, `/users/me/calendarList?${qs}`);
    entries.push(...(res.items ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);

  return entries
    .filter((e) => !e.primary && !e.id.endsWith('.v.calendar.google.com'))
    .map(toInfo)
    .sort((a, b) => a.summary.localeCompare(b.summary, 'ja'));
}

/** Google のサブカレンダー（自分で作ったカレンダー）かどうか。メインカレンダーの ID はメールアドレス */
export function isSubCalendarId(id: string): boolean {
  return id.endsWith('@group.calendar.google.com');
}

interface GEvent {
  status?: string;
  summary?: string;
  location?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** 期間内の予定。終日予定は startDate / endDate（YYYY-MM-DD、終了は翌日）で返す */
export interface RangeItem extends ScheduleItem {
  startDate?: string;
  endDate?: string;
}

/** q を指定すると、予定名・場所・説明にその言葉を含む予定だけを探す（空き時間のみの共有では検索できないので空を返す） */
export async function listGoogleItemsBetween(
  env: Env,
  calendarId: string,
  start: Date,
  end: Date,
  tz: string,
  q?: string,
): Promise<RangeItem[]> {
  const qs = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    timeZone: tz,
  });
  if (q) qs.set('q', q);
  let events: GEvent[];
  try {
    events = (await gapi<{ items?: GEvent[] }>(env, `/calendars/${cal(calendarId)}/events?${qs}`)).items ?? [];
  } catch (e) {
    if (e instanceof GoogleApiError && (e.status === 403 || e.status === 404)) {
      return q ? [] : freeBusyItems(env, calendarId, start, end, tz);
    }
    throw e;
  }
  const items: RangeItem[] = [];
  for (const ev of events) {
    if (ev.status === 'cancelled') continue;
    if (ev.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
    const title = ev.summary?.trim() || '予定あり';
    if (ev.start.date) {
      items.push({ title, allDay: true, startDate: ev.start.date, endDate: ev.end.date ?? ev.start.date, location: ev.location });
    } else if (ev.start.dateTime && ev.end.dateTime) {
      items.push({ title, allDay: false, start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime), location: ev.location });
    }
  }
  return items;
}

async function freeBusyItems(env: Env, calendarId: string, start: Date, end: Date, tz: string): Promise<ScheduleItem[]> {
  const res = await gapi<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(
    env,
    '/freeBusy',
    {
      method: 'POST',
      body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: tz, items: [{ id: calendarId }] }),
    },
  );
  const c = res.calendars[calendarId];
  if (!c || c.errors?.length) throw new GoogleApiError(403, 'カレンダーにアクセスできません');
  return (c.busy ?? []).map((b) => ({ title: '予定あり', allDay: false, start: new Date(b.start), end: new Date(b.end) }));
}

export interface NewEvent {
  summary: string;
  location?: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
}

export async function insertEvent(env: Env, calendarId: string, event: NewEvent): Promise<{ htmlLink: string }> {
  return gapi(env, `/calendars/${cal(calendarId)}/events`, { method: 'POST', body: JSON.stringify(event) });
}
