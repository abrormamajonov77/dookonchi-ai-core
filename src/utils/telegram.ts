import { env } from '../config/env';
import { MyContext } from '../bot/context';

export async function withChatAction<T>(ctx: any, action: string, task: () => Promise<T>): Promise<T> {
  await ctx.replyWithChatAction(action).catch(() => { });
  const timer = setInterval(() => ctx.replyWithChatAction(action).catch(() => { }), 4000);
  try { return await task(); } finally { clearInterval(timer); }
}

export async function handleInlineAction<T>(ctx: any, task: () => Promise<T>): Promise<T> {
  try { return await task(); } finally { await ctx.answerCallbackQuery().catch(() => { }); }
}

export async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Faylni yuklab bo'lmadi (${res.statusText})`);
  return Buffer.from(await res.arrayBuffer());
}

export const safeDelete = async (ctx: MyContext, chatId?: number | string, msgId?: number | null) => {
  if (chatId && msgId) await ctx.api.deleteMessage(chatId, msgId).catch(() => { });
};

export const clearSession = (ctx: MyContext) => {
  ctx.session.step = undefined;
  ctx.session.tempData = null;
};

export async function replyOrEdit(ctx: MyContext, text: string, keyboard?: any, isEdit = false) {
  const opts: any = { parse_mode: 'Markdown', reply_markup: keyboard };
  return isEdit && ctx.callbackQuery?.message
    ? ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, text, opts).catch(() => { })
    : ctx.reply(text, opts);
}

export function formatFriendlyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(msg)) return "Internet yoki AI javobi biroz kechikdi. Iltimos, qaytadan urinib ko'ring.";
  if (/503|429|unavailable|high demand/i.test(msg)) return "Tizimda vaqtinchalik yuklama bor. 5 soniyadan so'ng qayta yuboring.";
  return msg;
}

export function registerTemplateActions(composer: any, prefix: string, stepName: string, tempType: string, onConfirm: (ctx: MyContext, data: any) => Promise<string>) {
  composer.callbackQuery(`${prefix}:edit`, async (ctx: MyContext) => {
    ctx.session.step = stepName;
    await ctx.editMessageText("✍️ To'g'ri ma'lumotlarni qaytadan yozib yuboring (oddiy matnda yoki shablonda):");
  });
  composer.callbackQuery(new RegExp(`^confirm_${prefix}_conf_`), async (ctx: MyContext) => {
    if (ctx.session.tempData?.type !== tempType) return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
    try {
      await ctx.editMessageText(await onConfirm(ctx, ctx.session.tempData.data));
      clearSession(ctx);
    } catch {
      await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi, qayta urinib ko'ring.", show_alert: true });
    }
  });
  composer.callbackQuery(new RegExp(`^cancel_${prefix}_conf_`), async (ctx: MyContext) => {
    clearSession(ctx);
    await ctx.editMessageText('❌ Bekor qilindi.');
  });
}
