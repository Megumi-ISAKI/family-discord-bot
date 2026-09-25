// D1（登録メンバーとカレンダー）の読み書き

import type { CalendarReg, Env, Member } from './types';

export async function getMemberCalendars(env: Env, userId: string): Promise<CalendarReg[]> {
  const { results } = await env.DB.prepare('SELECT * FROM calendars WHERE user_id = ? ORDER BY id').bind(userId).all<CalendarReg>();
  return results;
}

export async function listMembers(env: Env): Promise<Member[]> {
  const [members, calendars] = await env.DB.batch([
    env.DB.prepare('SELECT user_id, display_name FROM members ORDER BY display_name'),
    env.DB.prepare('SELECT * FROM calendars ORDER BY id'),
  ]);
  const byUser = new Map<string, CalendarReg[]>();
  for (const c of calendars.results as unknown as CalendarReg[]) {
    byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c]);
  }
  return (members.results as unknown as { user_id: string; display_name: string }[])
    .map((m) => ({ ...m, calendars: byUser.get(m.user_id) ?? [] }))
    .filter((m) => m.calendars.length > 0);
}

/** 登録済みカレンダー → 登録したユーザー */
export async function registeredSources(env: Env): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare('SELECT source, user_id FROM calendars').all<{ source: string; user_id: string }>();
  return new Map(results.map((r) => [r.source, r.user_id]));
}

export async function upsertMember(env: Env, userId: string, displayName: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO members (user_id, display_name) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = datetime('now')`,
  )
    .bind(userId, displayName)
    .run();
}

export async function upsertCalendar(env: Env, c: Omit<CalendarReg, 'id'>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO calendars (user_id, kind, source, label, access_role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, source) DO UPDATE SET kind = excluded.kind, label = excluded.label, access_role = excluded.access_role`,
  )
    .bind(c.user_id, c.kind, c.source, c.label, c.access_role)
    .run();
}

/** カレンダーを削除し、1つも残らなければメンバーも削除する */
export async function deleteCalendars(env: Env, userId: string, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await env.DB.batch([
    ...ids.map((id) => env.DB.prepare('DELETE FROM calendars WHERE id = ? AND user_id = ?').bind(id, userId)),
    env.DB.prepare('DELETE FROM members WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM calendars WHERE user_id = ?)').bind(userId, userId),
  ]);
}
