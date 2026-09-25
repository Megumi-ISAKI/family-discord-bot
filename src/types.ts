export interface Env {
  DB: D1Database;
  TIMEZONE: string;
  GUILD_ID: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  /** Bot として使う家族アカウントの Gmail アドレス（登録手順に表示する） */
  BOT_GOOGLE_EMAIL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** npm run google-login で取得する */
  GOOGLE_REFRESH_TOKEN: string;
  /** おたよりOCR（Phase 3） */
  DISCORD_BOT_TOKEN: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  /** 推論の量（minimal / low など）。空ならモデルの既定 */
  OPENAI_REASONING_EFFORT: string;
  /** 📮-おたより等提出（フォーラム）のチャンネルID */
  OTAYORI_CHANNEL_ID: string;
  /** 家族アカウントのドライブの保存用フォルダID */
  OTAYORI_DRIVE_FOLDER_ID: string;
  /** AIコンシェルジュ（Phase 4） */
  CONCIERGE_REASONING_EFFORT: string;
  /** Bot 全体（OCR＋AIコンシェルジュ）の月の利用額の上限（ドル） */
  CONCIERGE_MONTHLY_BUDGET_USD: string;
  /** 利用額の計算に使う料金（100万トークンあたりのドル） */
  OPENAI_PRICE_INPUT_PER_M: string;
  OPENAI_PRICE_OUTPUT_PER_M: string;
  /** 請求書・支払い管理（Phase 5）：💸-請求書・支払い（フォーラム）のチャンネルID */
  BILLS_CHANNEL_ID: string;
  /** 転記先のスプレッドシートの ID（管理者が指定。家族アカウントが編集できること） */
  BILLS_SHEET_ID: string;
  /** 医療費の領収書（Phase 6）：🏥-医療費（フォーラム）のチャンネルID */
  MEDICAL_CHANNEL_ID: string;
  /** 「yyyy年医療費」シートと「yyyy年」写真フォルダを作る親フォルダ（家族アカウントのドライブ） */
  MEDICAL_FOLDER_ID: string;
}

export type CalendarKind = 'google' | 'ics';

export interface CalendarReg {
  id: number;
  user_id: string;
  kind: CalendarKind;
  /** google: カレンダーID（メインなら Gmail アドレス） / ics: ICS の URL */
  source: string;
  /** カレンダー名 */
  label: string;
  access_role: string | null;
}

export interface Member {
  user_id: string;
  display_name: string;
  calendars: CalendarReg[];
}

export interface ScheduleItem {
  title: string;
  allDay: boolean;
  start?: Date;
  end?: Date;
  location?: string;
  /** サブカレンダーの予定に付けるカレンダー名 */
  calendar?: string;
}
