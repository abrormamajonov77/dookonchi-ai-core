import { env } from '../config/env';
import { prisma } from '../database/prisma';
import { MyContext } from '../bot/context';

export async function withChatAction<T>(ctx: any, action: string, task: () => Promise<T>): Promise<T> {
  await ctx.replyWithChatAction(action).catch(() => {});
  const timer = setInterval(() => ctx.replyWithChatAction(action).catch(() => {}), 4000);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

export async function findOwnedPendingAction(id: string, userId: number | string | bigint) {
  return prisma.pendingAction
    .findFirst({
      where: { id, userId: BigInt(userId) },
    })
    .catch(() => null);
}

export async function deleteOwnedPendingAction(id: string, userId: number | string | bigint) {
  return prisma.pendingAction
    .deleteMany({
      where: { id, userId: BigInt(userId) },
    })
    .catch(() => {});
}

export async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { Connection: 'keep-alive' },
  });
  if (!res.ok) throw new Error(`Faylni yuklab bo'lmadi (${res.statusText})`);
  return Buffer.from(await res.arrayBuffer());
}

export const safeDelete = async (ctx: MyContext, chatId?: number | string, msgId?: number | null) => {
  if (chatId && msgId) await ctx.api.deleteMessage(chatId, msgId).catch(() => {});
};

export const clearSession = (ctx: MyContext) => {
  ctx.session.step = undefined;
  ctx.session.tempData = null;
};

export function sanitizeMdV1(text: string): string {
  return String(text ?? '').replace(/[*_`\[\]]/g, '');
}

export function truncateForTelegram(text: string, maxLen = 3950): string {
  const str = String(text ?? '');
  if (str.length <= maxLen) return str;
  const cut = str.slice(0, maxLen - 45);
  const fenceCount = (cut.match(/```/g) || []).length;
  const suffix = fenceCount % 2 === 1 ? '\n```\n... (qisqartirildi)' : '\n... (qisqartirildi)';
  return `${cut}${suffix}`;
}

export async function safeReply(ctx: MyContext, text: string, opts: Record<string, any> = {}) {
  const safeText = truncateForTelegram(text);
  try {
    return await ctx.reply(safeText, opts);
  } catch (err: any) {
    const desc = String(err?.description || err?.message || '');
    if (opts.parse_mode && /parse entities|can't find end/i.test(desc)) {
      const plainOpts = { ...opts };
      delete plainOpts.parse_mode;
      return await ctx.reply(truncateForTelegram(safeText.replace(/```/g, '')), plainOpts);
    }
    throw err;
  }
}

export async function safeEditMessageText(
  ctx: MyContext,
  chatId: number | string,
  messageId: number,
  text: string,
  opts: Record<string, any> = {}
) {
  const safeText = truncateForTelegram(text);
  try {
    return await ctx.api.editMessageText(chatId, messageId, safeText, opts);
  } catch (err: any) {
    const desc = String(err?.description || err?.message || '');
    if (/message is not modified/i.test(desc)) return;
    if (opts.parse_mode && /parse entities|can't find end/i.test(desc)) {
      const plainOpts = { ...opts };
      delete plainOpts.parse_mode;
      try {
        return await ctx.api.editMessageText(chatId, messageId, truncateForTelegram(safeText.replace(/```/g, '')), plainOpts);
      } catch (innerErr: any) {
        if (/message is not modified/i.test(String(innerErr?.description || innerErr?.message || ''))) return;
        throw innerErr;
      }
    }
    throw err;
  }
}

export async function replyOrEdit(ctx: MyContext, text: string, keyboard?: any, isEdit = false) {
  const opts: any = { parse_mode: 'Markdown', reply_markup: keyboard };
  if (isEdit && ctx.callbackQuery?.message && ctx.chat?.id) {
    try {
      return await safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, text, opts);
    } catch {
      return await safeReply(ctx, text, opts);
    }
  }
  return await safeReply(ctx, text, opts);
}

export function formatFriendlyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(msg)) return "Internet yoki AI javobi biroz kechikdi. Iltimos, qaytadan urinib ko'ring.";
  if (/503|429|unavailable|high demand/i.test(msg)) return "Tizimda vaqtinchalik yuklama bor. 5 soniyadan so'ng qayta yuboring.";
  return msg;
}

export function registerTemplateActions(
  composer: any,
  prefix: string,
  stepName: string,
  tempType: string,
  onConfirm: (ctx: MyContext, data: any) => Promise<string>
) {
  composer.callbackQuery(`${prefix}:edit`, async (ctx: MyContext) => {
    ctx.session.step = stepName;
    await ctx.editMessageText("✍️ To'g'ri ma'lumotlarni qaytadan yozib yuboring (oddiy matnda yoki shablonda):");
  });
  composer.callbackQuery(new RegExp(`^confirm_${prefix}_conf_`), async (ctx: MyContext) => {
    if (ctx.session.tempData?.type !== tempType) {
      return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
    }
    try {
      const msg = await onConfirm(ctx, ctx.session.tempData.data);
      await ctx.editMessageText(truncateForTelegram(msg));
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
