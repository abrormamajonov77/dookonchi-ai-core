import { BotError } from 'grammy';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { MemoryTtlCache } from '../../utils/cache';
import { clearSession, formatFriendlyError } from '../../utils/telegram';
import { MyContext } from '../context';

const adminAlertThrottle = new MemoryTtlCache<boolean>(60 * 1000, 200);

export async function errorMiddleware(err: BotError<MyContext>) {
  const ctx = err.ctx;
  const userId = ctx.from?.id ? String(ctx.from.id) : 'unknown';
  const action =
    ctx.callbackQuery?.data ||
    (ctx.message && 'text' in ctx.message ? ctx.message.text?.slice(0, 60) : undefined) ||
    (ctx.message && 'photo' in ctx.message ? 'message:photo' : undefined) ||
    (ctx.message && 'voice' in ctx.message ? 'message:voice' : undefined) ||
    ctx.session?.step ||
    'unknown_update';
  const rawErrMsg = err.error instanceof Error ? err.error.message : String(err.error);

  logger.error(
    { err: err.error, userId, action, step: ctx.session?.step, updateId: ctx.update?.update_id },
    'Global Bot Error Boundary caught unhandled error'
  );

  // Never leave inline button spinner hanging
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "⚠️ Vaqtinchalik xatolik yuz berdi, qayta urinib ko'ring." }).catch(() => {});
  }

  // Clear stuck session step so user is never trapped
  try {
    if (ctx.session) clearSession(ctx);
  } catch {
    // Ignore if session isn't initialized yet
  }

  // User-facing clear, non-technical guidance
  const friendlyHint = /timeout|timed out|503|429|unavailable/i.test(rawErrMsg)
    ? formatFriendlyError(err.error)
    : "Amaliyotni yakunlashda vaqtinchalik xatolik yuz berdi. Pastdagi menyudan bo'limni qayta tanlang yoki /start bosing.";
  await ctx.reply(`⚠️ ${friendlyHint}`).catch(() => {});

  // Notify Super-Admin with structured technical context (throttled to avoid alert storms)
  const alertKey = `${userId}:${rawErrMsg.slice(0, 80)}`;
  if (!adminAlertThrottle.get(alertKey) && env.OWNER_TELEGRAM_ID) {
    adminAlertThrottle.set(alertKey, true);
    const adminAlert =
      `🚨 SmartBaqqol Xatolik Hisoboti\n` +
      `👤 User ID: ${userId}\n` +
      `⚡ Amal: ${String(action).slice(0, 80)}\n` +
      `❌ Xato: ${rawErrMsg.slice(0, 300)}`;
    await ctx.api.sendMessage(env.OWNER_TELEGRAM_ID, adminAlert).catch(() => {});
  }
}
