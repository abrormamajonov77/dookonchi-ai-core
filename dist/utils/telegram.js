"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearSession = exports.safeDelete = void 0;
exports.withChatAction = withChatAction;
exports.findOwnedPendingAction = findOwnedPendingAction;
exports.deleteOwnedPendingAction = deleteOwnedPendingAction;
exports.downloadTelegramFile = downloadTelegramFile;
exports.sanitizeMdV1 = sanitizeMdV1;
exports.truncateForTelegram = truncateForTelegram;
exports.safeReply = safeReply;
exports.safeEditMessageText = safeEditMessageText;
exports.replyOrEdit = replyOrEdit;
exports.formatFriendlyError = formatFriendlyError;
exports.registerTemplateActions = registerTemplateActions;
const env_1 = require("../config/env");
const prisma_1 = require("../database/prisma");
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
async function findOwnedPendingAction(id, userId) {
    return prisma_1.prisma.pendingAction
        .findFirst({
        where: { id, userId: BigInt(userId) },
    })
        .catch(() => null);
}
async function deleteOwnedPendingAction(id, userId) {
    return prisma_1.prisma.pendingAction
        .deleteMany({
        where: { id, userId: BigInt(userId) },
    })
        .catch(() => { });
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
function sanitizeMdV1(text) {
    return String(text ?? '').replace(/[*_`\[\]]/g, '');
}
function truncateForTelegram(text, maxLen = 3950) {
    const str = String(text ?? '');
    if (str.length <= maxLen)
        return str;
    const cut = str.slice(0, maxLen - 45);
    const fenceCount = (cut.match(/```/g) || []).length;
    const suffix = fenceCount % 2 === 1 ? '\n```\n... (qisqartirildi)' : '\n... (qisqartirildi)';
    return `${cut}${suffix}`;
}
async function safeReply(ctx, text, opts = {}) {
    const safeText = truncateForTelegram(text);
    try {
        return await ctx.reply(safeText, opts);
    }
    catch (err) {
        const desc = String(err?.description || err?.message || '');
        if (opts.parse_mode && /parse entities|can't find end/i.test(desc)) {
            const plainOpts = { ...opts };
            delete plainOpts.parse_mode;
            return await ctx.reply(truncateForTelegram(safeText.replace(/```/g, '')), plainOpts);
        }
        throw err;
    }
}
async function safeEditMessageText(ctx, chatId, messageId, text, opts = {}) {
    const safeText = truncateForTelegram(text);
    try {
        return await ctx.api.editMessageText(chatId, messageId, safeText, opts);
    }
    catch (err) {
        const desc = String(err?.description || err?.message || '');
        if (/message is not modified/i.test(desc))
            return;
        if (opts.parse_mode && /parse entities|can't find end/i.test(desc)) {
            const plainOpts = { ...opts };
            delete plainOpts.parse_mode;
            try {
                return await ctx.api.editMessageText(chatId, messageId, truncateForTelegram(safeText.replace(/```/g, '')), plainOpts);
            }
            catch (innerErr) {
                if (/message is not modified/i.test(String(innerErr?.description || innerErr?.message || '')))
                    return;
                throw innerErr;
            }
        }
        throw err;
    }
}
async function replyOrEdit(ctx, text, keyboard, isEdit = false) {
    const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
    if (isEdit && ctx.callbackQuery?.message && ctx.chat?.id) {
        try {
            return await safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, text, opts);
        }
        catch {
            return await safeReply(ctx, text, opts);
        }
    }
    return await safeReply(ctx, text, opts);
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
            const msg = await onConfirm(ctx, ctx.session.tempData.data);
            await ctx.editMessageText(truncateForTelegram(msg));
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
