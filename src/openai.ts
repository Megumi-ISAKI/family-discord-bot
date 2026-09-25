// OpenAI Responses API でおたよりを読み取る

import { Buffer } from 'node:buffer';
import type { Env } from './types';

export interface OcrResult {
  title: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const PROMPT = `これは学校・園・習い事などから配られたお知らせ（おたより）です。
次の2つを日本語で返してください。

- text：書かれている文字をすべて、正確に書き起こしたもの。見出し・日付・時刻・持ち物・金額・締め切りは特に正確に。表や箇条書きは、読みやすい形のテキストに整える。手書きや読めない部分は［判読不能］と書く。文字がない場合は空にする。
- title：内容がひと目でわかる短い題名（20文字以内。例：遠足のお知らせ、10月の給食献立、保護者会の案内）。学校名や「お知らせ」だけの題名は避け、何のお知らせかがわかるようにする。`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['title', 'text'],
  additionalProperties: false,
};

export class OpenAiError extends Error {}

export async function ocrOtayori(env: Env, file: { data: ArrayBuffer; contentType: string; filename: string }): Promise<OcrResult> {
  const b64 = Buffer.from(file.data).toString('base64');
  const media =
    file.contentType === 'application/pdf'
      ? { type: 'input_file', filename: file.filename, file_data: `data:application/pdf;base64,${b64}` }
      : { type: 'input_image', image_url: `data:${file.contentType};base64,${b64}`, detail: 'high' };

  const body: Record<string, unknown> = {
    model: env.OPENAI_MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }, media] }],
    text: { format: { type: 'json_schema', name: 'otayori', strict: true, schema: SCHEMA } },
    max_output_tokens: 16000,
    store: false,
  };
  if (env.OPENAI_REASONING_EFFORT) body.reasoning = { effort: env.OPENAI_REASONING_EFFORT };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    status?: string;
    error?: { message: string };
    incomplete_details?: { reason: string };
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  if (!res.ok) throw new OpenAiError(`OpenAI ${res.status}: ${json.error?.message ?? 'unknown error'}`);
  if (json.status !== 'completed') throw new OpenAiError(`OpenAI の応答が途中で止まりました（${json.incomplete_details?.reason ?? json.status}）`);

  const out = json.output?.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text');
  if (!out?.text) throw new OpenAiError('OpenAI の応答に本文がありません');
  const parsed = JSON.parse(out.text) as { title: string; text: string };
  return {
    title: parsed.title.trim(),
    text: parsed.text.trim(),
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };
}

// ───────────── 請求書・支払い（Phase 5） ─────────────

export interface BillInfo {
  title: string;
  payee: string;
  amount: number | null;
  dueDate: string;
  method: string;
  bankInfo: string;
  notes: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const BILL_METHODS = ['振込', '集金・現金', 'コンビニ払い', 'カード・電子決済', 'その他', '不明'];

const BILL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    payee: { type: 'string' },
    amount: { type: ['integer', 'null'] },
    due_date: { type: 'string' },
    method: { type: 'string', enum: BILL_METHODS },
    bank_info: { type: 'string' },
    notes: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['title', 'payee', 'amount', 'due_date', 'method', 'bank_info', 'notes', 'text'],
  additionalProperties: false,
};

function billPrompt(today: string, postTitle: string, body: string, hasFiles: boolean): string {
  return `家族の「請求書・支払い」チャンネルへの投稿です。自動引き落とし以外の、振込・集金などの請求です。
${hasFiles ? '添付の画像・PDF（請求書など）と、' : ''}投稿のタイトル・本文から、支払いに必要な情報を取り出してください。今日は ${today} です。

# 投稿のタイトル
${postTitle || '（なし）'}

# 投稿の本文
${body || '（なし）'}

# 取り出すもの
- title：何の支払いかがひと目でわかる短い題名（20文字以内。例：10月分 給食費、町内会費、〇〇電気 修理代）
- payee：支払い先（会社・団体・人の名前）。不明なら空
- amount：支払う金額（円、整数）。税込の請求額・合計を優先。複数の金額があれば実際に支払う合計。不明なら null
- due_date：支払期限（YYYY-MM-DD）。年が書かれていなければ、今日以降で一番近い日付として補う。不明なら空
- method：支払方法。${BILL_METHODS.join('／')} から選ぶ（現金を集金袋で渡す・窓口で現金で払うなどは「集金・現金」）
- bank_info：振込先（銀行名・支店名・口座種別・口座番号・口座名義など）。書かれているとおりに1行で。なければ空
- notes：支払いで注意すること（振込手数料の負担、持参するもの、集金日、問い合わせ先など）。簡潔に。なければ空
- text：${hasFiles ? '画像・PDF に書かれている文字の全文の書き起こし' : '空'}`;
}

export async function extractBill(
  env: Env,
  post: { title: string; body: string; files: { data: ArrayBuffer; contentType: string; filename: string }[]; today: string },
): Promise<BillInfo> {
  const media = post.files.map((f) => {
    const b64 = Buffer.from(f.data).toString('base64');
    return f.contentType === 'application/pdf'
      ? { type: 'input_file', filename: f.filename, file_data: `data:application/pdf;base64,${b64}` }
      : { type: 'input_image', image_url: `data:${f.contentType};base64,${b64}`, detail: 'high' };
  });
  const body: Record<string, unknown> = {
    model: env.OPENAI_MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: billPrompt(post.today, post.title, post.body, media.length > 0) }, ...media] }],
    text: { format: { type: 'json_schema', name: 'bill', strict: true, schema: BILL_SCHEMA } },
    max_output_tokens: 16000,
    store: false,
  };
  if (env.OPENAI_REASONING_EFFORT) body.reasoning = { effort: env.OPENAI_REASONING_EFFORT };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    status?: string;
    error?: { message: string };
    incomplete_details?: { reason: string };
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  if (!res.ok) throw new OpenAiError(`OpenAI ${res.status}: ${json.error?.message ?? 'unknown error'}`);
  if (json.status !== 'completed') throw new OpenAiError(`OpenAI の応答が途中で止まりました（${json.incomplete_details?.reason ?? json.status}）`);
  const out = json.output?.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text');
  if (!out?.text) throw new OpenAiError('OpenAI の応答に本文がありません');
  const p = JSON.parse(out.text) as { title: string; payee: string; amount: number | null; due_date: string; method: string; bank_info: string; notes: string; text: string };
  return {
    title: p.title.trim(),
    payee: p.payee.trim(),
    amount: typeof p.amount === 'number' && p.amount > 0 ? Math.round(p.amount) : null,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(p.due_date) ? p.due_date : '',
    method: p.method,
    bankInfo: p.bank_info.trim(),
    notes: p.notes.trim(),
    text: p.text.trim(),
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };
}

// ───────────── 医療費の領収書（Phase 6） ─────────────

export const MEDICAL_CATEGORIES = ['診療・治療', '医薬品購入', '介護保険サービス', 'その他の医療費'] as const;

export interface MedicalInfo {
  patient: string;
  payee: string;
  category: (typeof MEDICAL_CATEGORIES)[number];
  amount: number | null;
  paidDate: string;
  notes: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const MEDICAL_SCHEMA = {
  type: 'object',
  properties: {
    patient: { type: 'string' },
    payee: { type: 'string' },
    category: { type: 'string', enum: [...MEDICAL_CATEGORIES] },
    amount: { type: ['integer', 'null'] },
    paid_date: { type: 'string' },
    notes: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['patient', 'payee', 'category', 'amount', 'paid_date', 'notes', 'text'],
  additionalProperties: false,
};

function medicalPrompt(p: { today: string; postTitle: string; body: string; family: string[]; tagged: string[]; hasFile: boolean }): string {
  return `家族の「医療費」チャンネルへの投稿です。確定申告の医療費控除のために、${p.hasFile ? '添付の領収書（画像・PDF）1枚' : '投稿の本文'}から情報を取り出してください。今日は ${p.today} です。

# 家族の名前（候補）
${p.family.length ? p.family.join('、') : '（なし）'}
# 投稿に付いているタグ（医療を受けた人）
${p.tagged.length ? p.tagged.join('、') : '（なし）'}
# 投稿のタイトル
${p.postTitle || '（なし）'}
# 投稿の本文
${p.body || '（なし）'}

# 取り出すもの
- patient：医療を受けた人。タグが1人ならその人。タグが複数なら、領収書の氏名に合う人をタグの中から選ぶ。タグがなければ、領収書の氏名を「家族の名前」の候補と照らして選び、合わなければ領収書の氏名をそのまま。わからなければ空
- payee：病院・薬局などの支払先の名称（例：〇〇クリニック、〇〇薬局）
- category：医療費の区分。${MEDICAL_CATEGORIES.join('／')} から選ぶ（病院・歯科・調剤薬局の処方 → 診療・治療、ドラッグストアでの市販薬の購入 → 医薬品購入）
- amount：支払った金額（円、整数。窓口で実際に払った自己負担額・領収金額）。ドラッグストアのレシートで医薬品以外（日用品・食品など）が混ざっている場合は、医薬品の分だけの合計にし、notes にその旨を書く。不明なら null
- paid_date：支払った日（YYYY-MM-DD）。年が書かれていなければ、今日以前で一番近い日付として補う。不明なら空
- notes：注意点（医薬品以外を除いた、判読しにくい箇所がある、など）。なければ空
- text：${p.hasFile ? '領収書に書かれている文字の全文の書き起こし' : '空'}`;
}

export async function extractMedical(
  env: Env,
  p: { today: string; postTitle: string; body: string; family: string[]; tagged: string[]; file?: { data: ArrayBuffer; contentType: string; filename: string } },
): Promise<MedicalInfo> {
  const content: unknown[] = [{ type: 'input_text', text: medicalPrompt({ ...p, hasFile: !!p.file }) }];
  if (p.file) {
    const b64 = Buffer.from(p.file.data).toString('base64');
    content.push(
      p.file.contentType === 'application/pdf'
        ? { type: 'input_file', filename: p.file.filename, file_data: `data:application/pdf;base64,${b64}` }
        : { type: 'input_image', image_url: `data:${p.file.contentType};base64,${b64}`, detail: 'high' },
    );
  }
  const body: Record<string, unknown> = {
    model: env.OPENAI_MODEL,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: 'medical', strict: true, schema: MEDICAL_SCHEMA } },
    max_output_tokens: 16000,
    store: false,
  };
  if (env.OPENAI_REASONING_EFFORT) body.reasoning = { effort: env.OPENAI_REASONING_EFFORT };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    status?: string;
    error?: { message: string };
    incomplete_details?: { reason: string };
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  if (!res.ok) throw new OpenAiError(`OpenAI ${res.status}: ${json.error?.message ?? 'unknown error'}`);
  if (json.status !== 'completed') throw new OpenAiError(`OpenAI の応答が途中で止まりました（${json.incomplete_details?.reason ?? json.status}）`);
  const out = json.output?.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text');
  if (!out?.text) throw new OpenAiError('OpenAI の応答に本文がありません');
  const r = JSON.parse(out.text) as { patient: string; payee: string; category: MedicalInfo['category']; amount: number | null; paid_date: string; notes: string; text: string };
  return {
    patient: r.patient.trim(),
    payee: r.payee.trim(),
    category: r.category,
    amount: typeof r.amount === 'number' && r.amount > 0 ? Math.round(r.amount) : null,
    paidDate: /^\d{4}-\d{2}-\d{2}$/.test(r.paid_date) ? r.paid_date : '',
    notes: r.notes.trim(),
    text: r.text.trim(),
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };
}
