"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearSession = exports.safeDelete = void 0;
exports.withChatAction = withChatAction;
exports.handleInlineAction = handleInlineAction;
exports.downloadTelegramFile = downloadTelegramFile;
exports.replyOrEdit = replyOrEdit;
exports.formatFriendlyError = formatFriendlyError;
exports.registerTemplateActions = registerTemplateActions;
const env_1 = require("../config/env");
async function withChatAction(ctx, action, task) {
    await ctx.replyWithChatAction(action).catch(() => { });
    const timer = setInterval(() => ctx.replyWithChatAction(action).catch(() => { }), 4000);
    try {
        return await task();
    }
    finally {
        clearInterval(timer);
    }
}
async function handleInlineAction(ctx, task) {
    try {
        return await task();
    }
    finally {
        await ctx.answerCallbackQuery().catch(() => { });
    }
}
async function downloadTelegramFile(filePath) {
    const res = await fetch(`https://api.telegram.org/file/bot${env_1.env.BOT_TOKEN}/${filePath}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok)
        throw new Error(`Faylni yuklab bo'lmadi (${res.statusText})`);
    return Buffer.from(await res.arrayBuffer());
}
const safeDelete = async (ctx, chatId, msgId) => {
    if (chatId && msgId)
        await ctx.api.deleteMessage(chatId, msgId).catch(() => { });
};
exports.safeDelete = safeDelete;
const clearSession = (ctx) => {
    ctx.session.step = undefined;
    ctx.session.tempData = null;
};
exports.clearSession = clearSession;
async function replyOrEdit(ctx, text, keyboard, isEdit = false) {
    const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
    return isEdit && ctx.callbackQuery?.message
        ? ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, text, opts).catch(() => { })
        : ctx.reply(text, opts);
}
function formatFriendlyError(error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out/i.test(msg))
        return "Internet yoki AI javobi biroz kechikdi. Iltimos, qaytadan urinib ko'ring.";
    if (/503|429|unavailable|high demand/i.test(msg))
        return "Tizimda vaqtinchalik yuklama bor. 5 soniyadan so'ng qayta yuboring.";
    return msg;
}
function registerTemplateActions(composer, prefix, stepName, tempType, onConfirm) {
    composer.callbackQuery(`${prefix}:edit`, async (ctx) => {
        ctx.session.step = stepName;
        await ctx.editMessageText("✍️ To'g'ri ma'lumotlarni qaytadan yozib yuboring (oddiy matnda yoki shablonda):");
    });
    composer.callbackQuery(new RegExp(`^confirm_${prefix}_conf_`), async (ctx) => {
        if (ctx.session.tempData?.type !== tempType)
            return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
        try {
            await ctx.editMessageText(await onConfirm(ctx, ctx.session.tempData.data));
            (0, exports.clearSession)(ctx);
        }
        catch {
            await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi, qayta urinib ko'ring.", show_alert: true });
        }
    });
    composer.callbackQuery(new RegExp(`^cancel_${prefix}_conf_`), async (ctx) => {
        (0, exports.clearSession)(ctx);
        await ctx.editMessageText('❌ Bekor qilindi.');
    });
}
