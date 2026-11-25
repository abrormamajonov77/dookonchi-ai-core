"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cashHandler = void 0;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const formatters_1 = require("../../utils/formatters");
const inline_1 = require("../keyboards/inline");
const telegram_1 = require("../../utils/telegram");
const transliterate_1 = require("../../utils/transliterate");
const cash_source_1 = require("../../utils/cash-source");
exports.cashHandler = new grammy_1.Composer();
exports.cashHandler.hears('💵 Naqd', async (ctx) => {
    if (!ctx.from)
        return;
    (0, telegram_1.clearSession)(ctx);
    const ownerId = String(ctx.from.id);
    const now = new Date();
    const { startOfDay, endOfDay } = (0, formatters_1.getTashkentDayRange)(now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 5 * 60 * 60 * 1000);
    const [recentTx, monthStats, todayTxs] = await Promise.all([
        prisma_1.prisma.cashTransaction.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 10 }),
        prisma_1.prisma.cashTransaction.aggregate({
            where: { ownerId, createdAt: { gte: monthStart } },
            _sum: { amount: true },
        }),
        prisma_1.prisma.cashTransaction.findMany({
            where: { ownerId, createdAt: { gte: startOfDay, lte: endOfDay }, currency: 'UZS' },
            select: { amount: true, cashSource: true, paymentSource: true },
        }),
    ]);
    let todayRegisterSum = 0;
    let todaySafeSum = 0;
    for (const tx of todayTxs) {
        const amt = Math.abs(Number(tx.amount || 0));
        if ((0, cash_source_1.isSafeCashSource)(tx))
            todaySafeSum += amt;
        else
            todayRegisterSum += amt;
    }
    const todayTotal = todayRegisterSum + todaySafeSum;
    const txLines = recentTx.length
        ? `📝 **Oxirgi 10 ta amaliyot:**\n` +
            recentTx
                .map((tx) => {
                const badge = (0, cash_source_1.formatCashSourceBadge)(tx.cashSource, tx.paymentSource);
                const badgeIcon = badge === 'Seyfdan' ? '🔐' : '💵';
                return `🔹 ${(0, formatters_1.formatDate)(tx.createdAt)} | **${(0, telegram_1.sanitizeMdV1)(tx.partyName)}** - ${(0, formatters_1.formatCurrency)(tx.amount, tx.currency)} [${badgeIcon} ${badge}]${tx.items ? `\n   ✏️ ${(0, telegram_1.sanitizeMdV1)(tx.items).slice(0, 80)}` : ''}`;
            })
                .join('\n')
        : "Amaliyotlar yo'q.";
    const todayBreakdown = `📊 **Bugungi jami naqd xaridlar:** ${(0, formatters_1.formatMoney)(todayTotal)}\n` +
        `   💵 Bugungi kassadan: ${(0, formatters_1.formatMoney)(todayRegisterSum)}\n` +
        `   🔐 Seyfdan (kechagi pul): ${(0, formatters_1.formatMoney)(todaySafeSum)}`;
    await (0, telegram_1.safeReply)(ctx, `💵 **Naqd Savdo va Xaridlar Arxiv:**\n\n${todayBreakdown}\n📊 **Shu oydagi aylanma:** ${(0, formatters_1.formatMoney)(monthStats._sum.amount || 0)}\n\n${txLines}`, { parse_mode: 'Markdown', reply_markup: new grammy_1.InlineKeyboard().text('➕ Yangi naqd xarid', 'cash:new') });
});
exports.cashHandler.callbackQuery('cash:new', async (ctx) => {
    ctx.session.step = 'ADD_CASH_TEMPLATE';
    await ctx.reply(`👇 **"Shablonni to'ldirish"** tugmasini bosing!\nShunda shablon matni avtomatik ravishda yozish maydoningizga tushadi va siz faqat kerakli joylarini to'ldirib yuborasiz.\n\n💡 *Eslatma:* Siz oddiy matn orqali (masalan: "Naqdga 200 ming shakar oldik") yozsangiz ham bot buni to'g'ri tushunadi.`, {
        parse_mode: 'Markdown',
        reply_markup: new grammy_1.InlineKeyboard().switchInlineCurrent("✍️ Shablonni to'ldirish", `Operatsiya: Naqd xarid\nKimdan/Brend: \nSumma: \nTovar/Izoh: `),
    });
});
exports.cashHandler.on('message:text', async (ctx, next) => {
    if (ctx.session.step !== 'ADD_CASH_TEMPLATE')
        return next();
    const text = ctx.message.text;
    if (!text.includes('Operatsiya: Naqd xarid')) {
        ctx.session.step = undefined;
        return next();
    }
    const partyName = (0, transliterate_1.toLatinUz)(text.match(/Kimdan\/Brend:\s*([^\n]+)/i)?.[1]?.trim() || '');
    const rawSummaLine = text.match(/Summa:\s*([^\n]+)/i)?.[1] || '';
    const parsedMoney = (0, formatters_1.parseCurrencyAndAmount)(rawSummaLine);
    const amount = (0, formatters_1.parseSmartAmount)(rawSummaLine) || parsedMoney.amount;
    const currency = parsedMoney.currency;
    const items = (0, transliterate_1.toLatinUz)(text.match(/Tovar\/Izoh:\s*([\s\S]+)/i)?.[1]?.trim() || '');
    if (!amount || amount <= 0)
        return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");
    const actionId = `cash_${Date.now()}`;
    ctx.session.tempData = {
        type: 'CASH_TEMPLATE',
        actionId,
        data: { amount, currency, partyName, items },
    };
    ctx.session.step = actionId;
    const confirmText = `🧾 *Naqd Xarid Tahlili:*\n` +
        `▫️ *Operatsiya:* Naqd tovar xaridi\n` +
        `▫️ *Kimdan:* ${(0, telegram_1.sanitizeMdV1)(partyName || "Noma'lum")}\n` +
        `▫️ *Summa:* ${(0, formatters_1.formatCurrency)(amount, currency)}\n` +
        `${items ? `▫️ *Tovar/Izoh:* ${(0, telegram_1.sanitizeMdV1)(items)}\n` : ''}` +
        `\n*(Bu operatsiya qarzlar balansiga ta'sir qilmaydi)*\n\n` +
        `${cash_source_1.CASH_SOURCE_PROMPT_TEXT}`;
    await (0, telegram_1.safeReply)(ctx, confirmText, {
        parse_mode: 'Markdown',
        reply_markup: (0, inline_1.getCashSourceSelectionKeyboard)(actionId, 'cash:edit'),
    });
});
exports.cashHandler.callbackQuery('cash:edit', async (ctx) => {
    ctx.session.step = 'ADD_CASH_TEMPLATE';
    await ctx.editMessageText("✍️ To'g'ri ma'lumotlarni qaytadan yozib yuboring (oddiy matnda yoki shablonda):");
});
// Safety guard if any legacy confirm_cash_conf_ button is tapped: always enforce cash source selection
exports.cashHandler.callbackQuery(/^confirm_cash_conf_/, async (ctx) => {
    if (ctx.session.tempData?.type !== 'CASH_TEMPLATE' || !ctx.session.tempData?.data) {
        return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
    }
    const actionId = ctx.session.tempData.actionId || `cash_${Date.now()}`;
    ctx.session.tempData.actionId = actionId;
    ctx.session.step = actionId;
    const { amount, currency = 'UZS', partyName, items } = ctx.session.tempData.data;
    const promptText = `🧾 *Naqd Xarid Tahlili:*\n` +
        `▫️ *Kimdan:* ${(0, telegram_1.sanitizeMdV1)(partyName || "Noma'lum")}\n` +
        `▫️ *Summa:* ${(0, formatters_1.formatCurrency)(amount, currency)}\n` +
        `${items ? `▫️ *Tovar/Izoh:* ${(0, telegram_1.sanitizeMdV1)(items)}\n` : ''}` +
        `\n${cash_source_1.CASH_SOURCE_PROMPT_TEXT}`;
    if (ctx.callbackQuery.message && ctx.chat?.id) {
        await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, promptText, {
            parse_mode: 'Markdown',
            reply_markup: (0, inline_1.getCashSourceSelectionKeyboard)(actionId, 'cash:edit'),
        });
    }
});
// Mandatory cash source selection callback for manual "💵 Naqd" purchases
exports.cashHandler.callbackQuery(/^cs:(T|S):(cash_.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const cashSource = ctx.match[1] === 'S' ? 'SAFE' : 'TODAY_REGISTER';
    const actionId = ctx.match[2];
    if (ctx.session.tempData?.type !== 'CASH_TEMPLATE' ||
        !ctx.session.tempData?.data ||
        (ctx.session.tempData.actionId && ctx.session.tempData.actionId !== actionId)) {
        return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
    }
    const ownerId = String(ctx.from.id);
    const { amount, currency = 'UZS', partyName, items } = ctx.session.tempData.data;
    const paymentSource = (0, cash_source_1.cashSourceToPaymentSource)(cashSource);
    const cleanParty = (0, transliterate_1.toLatinUz)(partyName || "Noma'lum").trim() || "Noma'lum";
    const cleanItems = items ? (0, transliterate_1.toLatinUz)(String(items)).trim() : null;
    try {
        await prisma_1.prisma.cashTransaction.create({
            data: {
                ownerId,
                partyName: cleanParty,
                amount,
                currency,
                paymentSource,
                cashSource,
                items: cleanItems,
                createdBy: ownerId,
            },
        });
        const sourceDisplay = (0, cash_source_1.formatCashSourceDisplay)(cashSource);
        const sourceBadge = (0, cash_source_1.formatCashSourceBadge)(cashSource);
        const zNote = (0, cash_source_1.formatCashSourceZReportNote)(cashSource);
        const msg = `✅ **Naqd xarid (${sourceBadge}) muvaffaqiyatli saqlandi!**\n\n` +
            `🏢 Kimdan: **${(0, telegram_1.sanitizeMdV1)(cleanParty)}**\n` +
            `💵 Summa: **${(0, formatters_1.formatCurrency)(amount, currency)}**\n` +
            `${cleanItems ? `📝 Izoh: ${(0, telegram_1.sanitizeMdV1)(cleanItems)}\n` : ''}` +
            `🗂 Pul manbasi: **${sourceDisplay}**\n` +
            `📊 Qarzga ta'sir qilmadi. ${zNote}`;
        if (ctx.callbackQuery.message && ctx.chat?.id) {
            await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, msg, {
                parse_mode: 'Markdown',
            });
        }
        (0, telegram_1.clearSession)(ctx);
    }
    catch {
        await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi, qayta urinib ko'ring.", show_alert: true });
    }
});
exports.cashHandler.callbackQuery(/^cancel_cash_/, async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await ctx.editMessageText('❌ Bekor qilindi.');
});
