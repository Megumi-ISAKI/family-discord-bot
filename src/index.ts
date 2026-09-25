import type { Env } from './types';
import { EPHEMERAL, InteractionType, ResponseType, json, postWebhook, verifyRequest, type Interaction } from './discord';
import { autocompleteChoices, handleCommand, handleComponent, isPublicQuestion } from './commands';
import { listMembers } from './db';
import { buildScheduleMessages } from './schedule';
import { homePage, privacyPage } from './pages';
import { pollOtayori } from './otayori';
import { pollBills } from './bills';
import { pollMedical } from './medical';
import { scheduledTargetDay } from './time';

/** おたよりOCRの確認間隔（wrangler.toml の crons と同じ文字列にする） */
const OTAYORI_CRON = '*/5 * * * *';
/** 請求書・支払い管理の確認間隔（おたよりと2分ずらす。wrangler.toml の crons と同じ文字列にする） */
const BILLS_CRON = '2-59/5 * * * *';
/** 医療費の領収書の確認間隔（4分ずらす。wrangler.toml の crons と同じ文字列にする） */
const MEDICAL_CRON = '4-59/5 * * * *';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'GET') {
      const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      const { pathname } = new URL(request.url);
      if (pathname === '/') return html(homePage());
      if (pathname === '/privacy') return html(privacyPage());
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
    if (body === null) return new Response('invalid request signature', { status: 401 });

    const interaction = JSON.parse(body) as Interaction;
    if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });

    if (interaction.guild_id !== env.GUILD_ID || !interaction.member) {
      return json({ type: ResponseType.MESSAGE, data: { content: 'このサーバーでは使えません。', flags: EPHEMERAL } });
    }

    switch (interaction.type) {
      case InteractionType.APPLICATION_COMMAND:
        // Discord は3秒以内の応答を求めるので、先に「考え中…」を返して処理は後で行う
        ctx.waitUntil(handleCommand(env, interaction));
        // `/質問` の回答はチャンネルの全員に見せる。それ以外のコマンドは本人にだけ表示
        return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: isPublicQuestion(interaction) ? 0 : EPHEMERAL } });
      case InteractionType.MESSAGE_COMPONENT:
        ctx.waitUntil(handleComponent(env, interaction));
        return json({ type: ResponseType.DEFERRED_UPDATE });
      case InteractionType.AUTOCOMPLETE:
        return json({ type: ResponseType.AUTOCOMPLETE_RESULT, data: { choices: await autocompleteChoices(env, interaction) } });
    }

    return new Response('unsupported interaction', { status: 400 });
  },

  /** 定期実行（wrangler.toml の crons で設定） */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === OTAYORI_CRON) return pollOtayori(env);
    if (controller.cron === BILLS_CRON) return pollBills(env);
    if (controller.cron === MEDICAL_CRON) return pollMedical(env);

    // 予定の自動投稿。朝は今日の予定、夜は明日の予定
    const members = await listMembers(env);
    if (members.length === 0) return;
    const at = new Date(controller.scheduledTime);
    const messages = await buildScheduleMessages(env, members, scheduledTargetDay(at, env.TIMEZONE), at);
    for (const embeds of messages) {
      await postWebhook(env.DISCORD_WEBHOOK_URL, { username: '家族の予定', embeds });
    }
  },
} satisfies ExportedHandler<Env>;
