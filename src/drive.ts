// Google ドライブ（家族アカウント）への保存

import type { Env } from './types';
import { GoogleApiError, googleFetch } from './google';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive の検索式に入れる文字列のエスケープ */
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function driveJson<T>(env: Env, url: string, init: RequestInit = {}): Promise<T> {
  const res = await googleFetch(env, url, init);
  if (!res.ok) throw new GoogleApiError(res.status, `Drive ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** 親フォルダの中に、指定した名前のフォルダを探す。なければ作る */
export async function ensureFolder(env: Env, parentId: string, name: string): Promise<string> {
  const query = `${q(parentId)} in parents and name = ${q(name)} and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const found = await driveJson<{ files: { id: string }[] }>(env, `${API}/files?${new URLSearchParams({ q: query, fields: 'files(id)', pageSize: '1' })}`);
  if (found.files.length) return found.files[0].id;
  const created = await driveJson<{ id: string }>(env, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return created.id;
}

/** 同じ名前があれば末尾に _2, _3 … を付けた名前を返す */
export async function uniqueName(env: Env, folderId: string, base: string, ext: string): Promise<string> {
  const query = `${q(folderId)} in parents and name contains ${q(base)} and trashed = false`;
  const res = await driveJson<{ files: { name: string }[] }>(env, `${API}/files?${new URLSearchParams({ q: query, fields: 'files(name)', pageSize: '100' })}`);
  const names = new Set(res.files.map((f) => f.name));
  if (!names.has(base + ext)) return base + ext;
  for (let i = 2; ; i++) if (!names.has(`${base}_${i}${ext}`)) return `${base}_${i}${ext}`;
}

/** ファイルをアップロードする（再開可能アップロード。5MB を超える写真にも対応） */
export async function uploadFile(
  env: Env,
  file: { folderId: string; name: string; mimeType: string; description: string; data: ArrayBuffer },
): Promise<{ id: string; webViewLink: string }> {
  const init = await googleFetch(env, `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': file.mimeType },
    body: JSON.stringify({ name: file.name, parents: [file.folderId], description: file.description, mimeType: file.mimeType }),
  });
  const location = init.headers.get('location');
  if (!init.ok || !location) throw new GoogleApiError(init.status, `Drive アップロードの開始に失敗: ${await init.text()}`);

  const put = await fetch(location, { method: 'PUT', headers: { 'content-type': file.mimeType }, body: file.data });
  if (!put.ok) throw new GoogleApiError(put.status, `Drive アップロードに失敗: ${await put.text()}`);
  return (await put.json()) as { id: string; webViewLink: string };
}

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** フォルダの中の、指定した名前のスプレッドシートを探す。なければ作る。作ったときは created = true */
export async function ensureSpreadsheet(env: Env, parentId: string, name: string): Promise<{ id: string; created: boolean }> {
  const query = `${q(parentId)} in parents and name = ${q(name)} and mimeType = '${SHEET_MIME}' and trashed = false`;
  const found = await driveJson<{ files: { id: string }[] }>(env, `${API}/files?${new URLSearchParams({ q: query, fields: 'files(id)', pageSize: '1' })}`);
  if (found.files.length) return { id: found.files[0].id, created: false };
  const created = await driveJson<{ id: string }>(env, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: SHEET_MIME, parents: [parentId] }),
  });
  return { id: created.id, created: true };
}
