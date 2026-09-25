// Google スプレッドシート（請求書・支払い管理、医療費の転記先）
// 1行目の見出しの「名前」で列を探すので、既存の表の列の並びや、ほかの列があっても使える。

import type { Env } from './types';
import { GoogleApiError, googleFetch } from './google';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Bot が使う列（見出しの名前）。表に無い列は右端に追加する */
export const BILL_COLUMNS = ['登録日', '支払期限', '支払い先', '金額', '内容', '支払方法', '振込先', '状態', '支払日', 'Discord', '管理番号'] as const;
export type BillColumn = (typeof BILL_COLUMNS)[number];

export const STATUS_UNPAID = '未払い';
export const STATUS_PAID = '支払い済';

/** 「支払い済」とみなす書き方（手入力の揺れを許す） */
export function isPaidStatus(value: string | undefined): boolean {
  return /^(支払い?済み?|支払い?完了|済み?|paid)$/i.test((value ?? '').trim());
}

export interface SheetInfo {
  id: string;
  tab: string;
  gid: number;
  /** 見出しの名前 → 列番号（0 始まり） */
  columns: Map<string, number>;
  width: number;
}

export async function sheetsJson<T>(env: Env, url: string, init: RequestInit = {}): Promise<T> {
  const res = await googleFetch(env, url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  if (!res.ok) throw new GoogleApiError(res.status, `Sheets ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** 列番号（0 始まり）→ A, B, …, Z, AA … */
export function colLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export const range = (tab: string, a1: string) => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${a1}`);

/** 追加した列に付ける書式を作る関数に渡す情報 */
export interface FormatContext {
  gid: number;
  columns: Map<string, number>;
  /** 今回追加した列 */
  added: readonly string[];
  /** 見出しが空の表だったか */
  fresh: boolean;
}
export type Formatter = (ctx: FormatContext) => unknown[];

/** 先頭のシート（タブ）を使う。見出しを確かめ、足りない列を右端に追加して書式を付ける */
export async function openSheet(env: Env, id: string, wanted: readonly string[], formatter: Formatter): Promise<SheetInfo> {
  const meta = await sheetsJson<{ sheets: { properties: { title: string; sheetId: number } }[] }>(
    env,
    `${API}/${id}?fields=sheets.properties(title,sheetId)`,
  );
  const { title: tab, sheetId: gid } = meta.sheets[0].properties;

  const head = await sheetsJson<{ values?: string[][] }>(env, `${API}/${id}/values/${range(tab, '1:1')}`);
  const header = (head.values?.[0] ?? []).map((h) => String(h).trim());
  const columns = new Map<string, number>();
  header.forEach((h, i) => h && !columns.has(h) && columns.set(h, i));

  const missing = wanted.filter((c) => !columns.has(c));
  if (missing.length) {
    // 見出しの右端（空の表なら A 列）から追加する
    let next = header.length;
    while (next > 0 && !header[next - 1]) next--;
    for (const c of missing) columns.set(c, next++);
    await sheetsJson(env, `${API}/${id}/values/${range(tab, `${colLetter(columns.get(missing[0])!)}1`)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [missing] }),
    });
    const fresh = header.filter(Boolean).length === 0;
    const requests = [...formatter({ gid, columns, added: missing, fresh }), ...(fresh ? headerFormat(gid) : [])];
    if (requests.length) await sheetsJson(env, `${API}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  }
  const width = Math.max(...columns.values()) + 1;
  return { id, tab, gid, columns, width };
}

/** 空の表に見出しを作ったとき：見出しを太字にして固定する */
function headerFormat(gid: number): unknown[] {
  return [
    { updateSheetProperties: { properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
  ];
}

/** 列（2行目以降）の範囲 */
export function columnRange(ctx: FormatContext, name: string) {
  const i = ctx.columns.get(name)!;
  return { sheetId: ctx.gid, startColumnIndex: i, endColumnIndex: i + 1, startRowIndex: 1 };
}

export function currencyFormat(ctx: FormatContext, name: string): unknown {
  return {
    repeatCell: {
      range: columnRange(ctx, name),
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"¥"#,##0' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  };
}

export function dropdown(ctx: FormatContext, name: string, values: string[]): unknown {
  return {
    setDataValidation: {
      range: columnRange(ctx, name),
      rule: { condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
    },
  };
}

export function hideColumn(ctx: FormatContext, name: string): unknown {
  const i = ctx.columns.get(name)!;
  return {
    updateDimensionProperties: {
      range: { sheetId: ctx.gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  };
}

/** 請求書のシートに追加した列の書式：状態のプルダウン、支払い済の行を灰色に、金額の円表示、管理番号の非表示 */
const billFormat: Formatter = (ctx) => {
  const requests: unknown[] = [];
  if (ctx.added.includes('状態')) {
    requests.push(dropdown(ctx, '状態', [STATUS_UNPAID, STATUS_PAID]));
    const statusCol = colLetter(ctx.columns.get('状態')!);
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId: ctx.gid, startRowIndex: 1 }],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=$${statusCol}2="${STATUS_PAID}"` }] },
            format: { textFormat: { foregroundColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
          },
        },
      },
    });
  }
  if (ctx.added.includes('金額')) requests.push(currencyFormat(ctx, '金額'));
  if (ctx.added.includes('管理番号')) requests.push(hideColumn(ctx, '管理番号'));
  return requests;
};

export function openBillSheet(env: Env): Promise<SheetInfo> {
  return openSheet(env, env.BILLS_SHEET_ID, BILL_COLUMNS, billFormat);
}

export function appendBillRow(env: Env, sheet: SheetInfo, values: Partial<Record<BillColumn, string | number>>): Promise<number> {
  return appendRow(env, sheet, values);
}

/** 1行追加し、追加した行番号（1 始まり）を返す。見出しの名前で列を合わせる */
export async function appendRow(env: Env, sheet: SheetInfo, values: Record<string, string | number | undefined>): Promise<number> {
  const row: (string | number)[] = Array(sheet.width).fill('');
  for (const [name, value] of Object.entries(values)) {
    const i = sheet.columns.get(name);
    if (i !== undefined && value !== undefined) row[i] = value;
  }
  const res = await sheetsJson<{ updates: { updatedRange: string } }>(
    env,
    `${API}/${sheet.id}/values/${range(sheet.tab, 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [row] }) },
  );
  const m = res.updates.updatedRange.match(/!\$?[A-Z]+\$?(\d+)/);
  return m ? Number(m[1]) : 0;
}

export interface SheetBillRow {
  row: number;
  threadId: string;
  status: string;
  paidDate: string;
}

/** 管理番号のある行の、状態と支払日を読む */
export async function readBillRows(env: Env, sheet: SheetInfo): Promise<SheetBillRow[]> {
  const res = await sheetsJson<{ values?: string[][] }>(env, `${API}/${sheet.id}/values/${range(sheet.tab, `A2:${colLetter(sheet.width - 1)}`)}`);
  const idCol = sheet.columns.get('管理番号')!;
  const statusCol = sheet.columns.get('状態')!;
  const dateCol = sheet.columns.get('支払日')!;
  return (res.values ?? [])
    .map((r, i) => ({ row: i + 2, threadId: String(r[idCol] ?? '').replace(/^'/, '').trim(), status: String(r[statusCol] ?? ''), paidDate: String(r[dateCol] ?? '') }))
    .filter((r) => /^\d{15,20}$/.test(r.threadId));
}

/** 指定した行の状態と支払日を書き換える */
export async function setBillStatus(env: Env, sheet: SheetInfo, row: number, paid: boolean, paidDate: string): Promise<void> {
  const cell = (name: BillColumn) => `'${sheet.tab.replace(/'/g, "''")}'!${colLetter(sheet.columns.get(name)!)}${row}`;
  await sheetsJson(env, `${API}/${sheet.id}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: cell('状態'), values: [[paid ? STATUS_PAID : STATUS_UNPAID]] },
        { range: cell('支払日'), values: [[paid ? paidDate : '']] },
      ],
    }),
  });
}

export function rowUrl(sheet: SheetInfo, row: number): string {
  return `https://docs.google.com/spreadsheets/d/${sheet.id}/edit#gid=${sheet.gid}&range=A${row}`;
}
