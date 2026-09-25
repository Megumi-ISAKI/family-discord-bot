// Discord Interactions の検証と送信まわり

import type { Embed } from './schedule';

const API = 'https://discord.com/api/v10';

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4 } as const;
export const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, AUTOCOMPLETE_RESULT: 8 } as const;
export const EPHEMERAL = 64;

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
}

export interface Interaction {
  type: number;
  token: string;
  guild_id?: string;
  data?: {
    /** スラッシュコマンド */
    name?: string;
    options?: CommandOption[];
    /** メッセージコンポーネント（選択メニュー） */
    custom_id?: string;
    values?: string[];
  };
  member?: { nick?: string | null; user: DiscordUser };
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface ActionRow {
  type: 1;
  components: { type: 3; custom_id: string; placeholder?: string; min_values?: number; max_values?: number; options: SelectOption[] }[];
}

export interface MessageBody {
  content?: string;
  embeds?: Embed[];
  components?: ActionRow[];
  flags?: number;
}

/** 選択メニューを1つ持つ行を作る（選択肢は最大25個、文字数は100まで） */
export function selectMenu(customId: string, placeholder: string, options: SelectOption[], maxValues = options.length): ActionRow {
  const cut = (t: string) => (t.length > 100 ? t.slice(0, 99) + '…' : t);
  options = options.slice(0, 25);
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: customId,
        placeholder,
        min_values: 1,
        max_values: Math.max(1, Math.min(maxValues, options.length)),
        options: options.map((o) => ({ ...o, label: cut(o.label), description: o.description && cut(o.description) })),
      },
    ],
  };
}

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

export async function verifyRequest(request: Request, publicKey: string): Promise<string | null> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  if (!signature || !timestamp) return null;
  const key = await crypto.subtle.importKey('raw', hexToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify('Ed25519', key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  return ok ? body : null;
}

export function focusedOption(i: Interaction): CommandOption | undefined {
  return i.data?.options?.find((o) => o.focused);
}

export function getOption<T extends string | number | boolean = string>(i: Interaction, name: string): T | undefined {
  return i.data?.options?.find((o) => o.name === name)?.value as T | undefined;
}

export function displayName(i: Interaction): string {
  const m = i.member!;
  return m.nick || m.user.global_name || m.user.username;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const noMentions = { allowed_mentions: { parse: [] } };

/** 「考え中…」の応答を差し替える */
export async function editOriginal(appId: string, token: string, body: MessageBody): Promise<void> {
  const res = await fetch(`${API}/webhooks/${appId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...noMentions }),
  });
  if (!res.ok) console.error('editOriginal failed', res.status, await res.text());
}

export async function followup(appId: string, token: string, body: MessageBody): Promise<void> {
  const res = await fetch(`${API}/webhooks/${appId}/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...noMentions }),
  });
  if (!res.ok) console.error('followup failed', res.status, await res.text());
}

export async function postWebhook(url: string, body: MessageBody & { username?: string }): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...noMentions }),
  });
  if (!res.ok) throw new Error(`Webhook への投稿に失敗 (${res.status}): ${await res.text()}`);
}

// ───────────── Bot トークンでの REST API（おたよりOCR用） ─────────────

export class DiscordApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

export interface DiscordMessage {
  id: string;
  type: number;
  channel_id: string;
  timestamp: string;
  content?: string;
  author: { id: string; bot?: boolean };
  attachments: DiscordAttachment[];
}

export interface DiscordThread {
  id: string;
  name?: string;
  parent_id?: string;
  applied_tags?: string[];
  thread_metadata?: { archived?: boolean; locked?: boolean };
  last_message_id?: string | null;
}

export async function botApi<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new DiscordApiError(res.status, `${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
