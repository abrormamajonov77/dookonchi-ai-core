"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearSession = exports.safeDelete = exports.httpsKeepAliveAgent = exports.httpKeepAliveAgent = void 0;
exports.withChatAction = withChatAction;
exports.handleInlineAction = handleInlineAction;
exports.downloadTelegramFile = downloadTelegramFile;
exports.replyOrEdit = replyOrEdit;
exports.formatFriendlyError = formatFriendlyError;
exports.registerTemplateActions = registerTemplateActions;
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const env_1 = require("../config/env");
exports.httpKeepAliveAgent = new node_http_1.default.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
});
exports.httpsKeepAliveAgent = new node_https_1.default.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
});
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
    const url = `https://api.telegram.org/file/bot${env_1.env.BOT_TOKEN}/${filePath}`;
    const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { Connection: 'keep-alive' },
    });
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
        if (ctx.session.tempData?.type !== tempType) {
            return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
        }
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
