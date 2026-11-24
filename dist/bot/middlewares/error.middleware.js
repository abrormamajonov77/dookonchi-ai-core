"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMiddleware = errorMiddleware;
const admin_1 = require("../../utils/admin");
const logger_1 = require("../../config/logger");
const cache_1 = require("../../utils/cache");
const telegram_1 = require("../../utils/telegram");
const adminAlertThrottle = new cache_1.MemoryTtlCache(60 * 1000, 200);
async function errorMiddleware(err) {
    const ctx = err.ctx;
    const userId = ctx.from?.id ? String(ctx.from.id) : 'unknown';
    const action = ctx.callbackQuery?.data ||
        (ctx.message && 'text' in ctx.message ? ctx.message.text?.slice(0, 60) : undefined) ||
        (ctx.message && 'photo' in ctx.message ? 'message:photo' : undefined) ||
        (ctx.message && 'voice' in ctx.message ? 'message:voice' : undefined) ||
        ctx.session?.step ||
        'unknown_update';
    const rawErrMsg = err.error instanceof Error ? err.error.message : String(err.error);
    logger_1.logger.error({ err: err.error, userId, action, step: ctx.session?.step, updateId: ctx.update?.update_id }, 'Global Bot Error Boundary caught unhandled error');
    // Never leave inline button spinner hanging
    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "⚠️ Vaqtinchalik xatolik yuz berdi, qayta urinib ko'ring." }).catch(() => { });
    }
    // Clear stuck session step so user is never trapped
    try {
        if (ctx.session)
            (0, telegram_1.clearSession)(ctx);
    }
    catch {
        // Ignore if session isn't initialized yet
    }
    // User-facing clear, non-technical guidance
    const friendlyHint = /timeout|timed out|503|429|unavailable/i.test(rawErrMsg)
        ? (0, telegram_1.formatFriendlyError)(err.error)
        : "Amaliyotni yakunlashda vaqtinchalik xatolik yuz berdi. Pastdagi menyudan bo'limni qayta tanlang yoki /start bosing.";
    await ctx.reply(`⚠️ ${friendlyHint}`).catch(() => { });
    // Notify Super-Admins with structured technical context (throttled to avoid alert storms)
    const alertKey = `${userId}:${rawErrMsg.slice(0, 80)}`;
    const adminIds = Array.from((0, admin_1.getSuperAdminIds)());
    if (!adminAlertThrottle.get(alertKey) && adminIds.length > 0) {
        adminAlertThrottle.set(alertKey, true);
        const adminAlert = `🚨 SmartBaqqol Xatolik Hisoboti\n` +
            `👤 User ID: ${userId}\n` +
            `⚡ Amal: ${String(action).slice(0, 80)}\n` +
            `❌ Xato: ${rawErrMsg.slice(0, 300)}`;
        await Promise.all(adminIds.map((adminId) => ctx.api.sendMessage(adminId, adminAlert).catch(() => { })));
    }
}
