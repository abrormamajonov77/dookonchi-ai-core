"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debtHandler = void 0;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const formatters_1 = require("../../utils/formatters");
const inline_1 = require("../keyboards/inline");
const menu_1 = require("../keyboards/menu");
const telegram_1 = require("../../utils/telegram");
const transliterate_1 = require("../../utils/transliterate");
exports.debtHandler = new grammy_1.Composer();
const PER_PAGE = 10;
async function applyCustomerPaymentFIFO(ownerId, customerName, payAmount, currency = 'UZS') {
    return prisma_1.prisma.$transaction(async (tx) => {
        const activeDebts = await tx.customerDebt.findMany({
            where: { ownerId, customerName, currency, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
            orderBy: { createdAt: 'asc' },
            select: { id: true, amount: true, paidAmount: true },
        });
        let unapplied = Number(payAmount.toFixed(2));
        for (const d of activeDebts) {
            if (unapplied <= 0)
                break;
            const rem = Number((Number(d.amount) - Number(d.paidAmount)).toFixed(2));
            if (rem <= 0)
                continue;
            if (unapplied >= rem) {
                await tx.customerDebt.update({
                    where: { id: d.id },
                    data: { paidAmount: d.amount, status: 'PAID' },
                });
                unapplied = Number((unapplied - rem).toFixed(2));
            }
            else {
                await tx.customerDebt.update({
                    where: { id: d.id },
                    data: { paidAmount: Number((Number(d.paidAmount) + unapplied).toFixed(2)), status: 'PARTIALLY_PAID' },
                });
                unapplied = 0;
            }
        }
        const remDebts = await tx.customerDebt.findMany({
            where: { ownerId, customerName, currency, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
            select: { amount: true, paidAmount: true },
        });
        return remDebts.reduce((acc, d) => Number((acc + (Number(d.amount) - Number(d.paidAmount))).toFixed(2)), 0);
    });
}
async function sendDebtorsPage(ctx, page, isEdit = false) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const debts = await prisma_1.prisma.customerDebt.findMany({
        where: { ownerId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, customerName: true, amount: true, paidAmount: true, currency: true },
    });
    const kb = new grammy_1.InlineKeyboard();
    if (!debts.length)
        return (0, telegram_1.replyOrEdit)(ctx, 'Nasiyalar mavjud emas.', kb.text("➕ Nasiya qo'shish", 'debt:new'), isEdit);
    let totalUzs = 0;
    let totalUsd = 0;
    const grouped = {};
    for (const d of debts) {
        const rem = Number((Number(d.amount) - Number(d.paidAmount)).toFixed(2));
        if (rem > 0) {
            grouped[d.customerName] ??= { sumUzs: 0, sumUsd: 0, firstId: d.id };
            if (d.currency === 'USD') {
                grouped[d.customerName].sumUsd = Number((grouped[d.customerName].sumUsd + rem).toFixed(2));
                totalUsd = Number((totalUsd + rem).toFixed(2));
            }
            else {
                grouped[d.customerName].sumUzs = Number((grouped[d.customerName].sumUzs + rem).toFixed(2));
                totalUzs = Number((totalUzs + rem).toFixed(2));
            }
        }
    }
    const groupedArray = Object.entries(grouped).sort((a, b) => b[1].sumUzs - a[1].sumUzs || b[1].sumUsd - a[1].sumUsd);
    const totalPages = Math.ceil(groupedArray.length / PER_PAGE) || 1;
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const pageItems = groupedArray.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);
    const lines = pageItems
        .map(([name, data]) => (0, formatters_1.formatSupplierDebtLine)(name, data.sumUzs, data.sumUsd, '👤 '))
        .join('\n');
    const text = `👥 **Nasiyadorlar (Sahifa ${currentPage}/${totalPages})**\n\n` +
        `${lines}\n\n` +
        `${(0, formatters_1.formatTotalDebtBlock)(totalUzs, totalUsd)}`;
    (0, inline_1.addTwoColButtons)(kb, pageItems, ([n]) => n, ([, d]) => d.sumUzs || d.sumUsd, ([, d]) => `debt:v:${d.firstId}`);
    (0, inline_1.addPaginationRow)(kb, currentPage, totalPages, 'debt:p:');
    kb.text('➕ Yangi', 'debt:new').text('🔙 Asosiy', 'menu:main');
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
exports.debtHandler.hears('👥 Nasiyadorlar', async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await sendDebtorsPage(ctx, 1);
});
exports.debtHandler.callbackQuery(/^debt:p:(\d+)$/, (ctx) => sendDebtorsPage(ctx, parseInt(ctx.match[1], 10), true));
exports.debtHandler.callbackQuery('debt:back', (ctx) => sendDebtorsPage(ctx, 1, true));
exports.debtHandler.callbackQuery(/^debt:v:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const firstId = ctx.match[1];
    const firstDebt = await prisma_1.prisma.customerDebt.findFirst({
        where: { id: firstId, ownerId },
        select: { id: true, customerName: true },
    });
    if (!firstDebt)
        return ctx.answerCallbackQuery('Topilmadi');
    const name = firstDebt.customerName;
    const debts = await prisma_1.prisma.customerDebt.findMany({
        where: { ownerId, customerName: name, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        orderBy: { createdAt: 'desc' },
        select: { amount: true, paidAmount: true, currency: true, createdAt: true, itemsSummary: true },
    });
    let totalUzs = 0;
    let totalUsd = 0;
    const lines = debts
        .map((d) => {
        const rem = Number((Number(d.amount) - Number(d.paidAmount)).toFixed(2));
        if (d.currency === 'USD')
            totalUsd = Number((totalUsd + rem).toFixed(2));
        else
            totalUzs = Number((totalUzs + rem).toFixed(2));
        return `🔹 ${(0, formatters_1.formatDate)(d.createdAt)} | **${(0, formatters_1.formatCurrency)(rem, d.currency)}**${d.itemsSummary ? `\n   📝 ${(0, telegram_1.sanitizeMdV1)(d.itemsSummary)}` : ''}`;
    })
        .join('\n');
    const shareText = `Hurmatli ${name}, do'konimiz hisobida sizning qolgan nasiya summangiz: ${(0, formatters_1.formatCurrency)(totalUzs, 'UZS')}${totalUsd > 0 ? ` va ${(0, formatters_1.formatCurrency)(totalUsd, 'USD')}` : ''}. Rahmat!`;
    const kb = new grammy_1.InlineKeyboard()
        .switchInlineCurrent("➕ Yangi qarz qo'shish", `Operatsiya: Nasiya\nMijoz: ${name}\nSumma: \nTelefon: \nIzoh: `)
        .row()
        .text("💸 Qarz to'lash (Yopish)", `debt:pay:${firstId}`)
        .row()
        .url('📤 Mijozga eslatma yuborish', `https://t.me/share/url?url=${encodeURIComponent(shareText)}`)
        .row()
        .text('🔙 Orqaga', 'debt:back');
    await (0, telegram_1.replyOrEdit)(ctx, `👤 **Mijoz:** ${(0, telegram_1.sanitizeMdV1)(name)}\n\n${lines}\n\n${(0, formatters_1.formatTotalDebtBlock)(totalUzs, totalUsd)}`, kb, true);
});
exports.debtHandler.callbackQuery(/^debt:pay:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const firstId = ctx.match[1];
    const firstDebt = await prisma_1.prisma.customerDebt.findFirst({
        where: { id: firstId, ownerId },
        select: { customerName: true, currency: true },
    });
    if (!firstDebt)
        return ctx.answerCallbackQuery('Mijoz topilmadi.');
    const agg = await prisma_1.prisma.customerDebt.aggregate({
        where: {
            ownerId,
            customerName: firstDebt.customerName,
            currency: firstDebt.currency,
            status: { in: ['PENDING', 'PARTIALLY_PAID'] },
        },
        _sum: { amount: true, paidAmount: true },
    });
    const totalRem = Number((Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0)).toFixed(2));
    ctx.session.step = 'DEBT_PAYMENT';
    ctx.session.tempData = { customerName: firstDebt.customerName, firstId, totalRem };
    const kb = totalRem > 0
        ? new grammy_1.InlineKeyboard()
            .text(`💯 To'liq yopish (${(0, formatters_1.formatCurrency)(totalRem, firstDebt.currency)})`, `debt:qpay:${firstId}:${totalRem}`)
            .row()
            .text(`🌓 Yarmini yopish (${(0, formatters_1.formatCurrency)(Number((totalRem / 2).toFixed(2)), firstDebt.currency)})`, `debt:qpay:${firstId}:${Number((totalRem / 2).toFixed(2))}`)
        : undefined;
    await (0, telegram_1.safeReply)(ctx, `💸 **${(0, telegram_1.sanitizeMdV1)(firstDebt.customerName)}** tomonidan to'langan summani raqamda kiriting:\n(Masalan: 50000, 50 ming yoki $25.50)`, { parse_mode: 'Markdown', reply_markup: kb });
});
exports.debtHandler.callbackQuery(/^debt:qpay:(.+):([\d.]+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const [, firstId, rawAmt] = ctx.match;
    const payAmount = Number(rawAmt);
    const firstDebt = await prisma_1.prisma.customerDebt.findFirst({
        where: { id: firstId, ownerId },
        select: { customerName: true, currency: true },
    });
    if (!firstDebt || !payAmount)
        return ctx.answerCallbackQuery('Topilmadi');
    const customerName = firstDebt.customerName;
    const remainingTotal = await applyCustomerPaymentFIFO(ownerId, customerName, payAmount, firstDebt.currency);
    (0, telegram_1.clearSession)(ctx);
    const suffix = remainingTotal > 0
        ? `💰 **Qolgan nasiya summasi:** ${(0, formatters_1.formatCurrency)(remainingTotal, firstDebt.currency)}`
        : `🎉 **${(0, telegram_1.sanitizeMdV1)(customerName)} barcha qarzlarini to'liq yopdi!**`;
    if (ctx.callbackQuery.message && ctx.chat?.id) {
        await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, `✅ **${(0, telegram_1.sanitizeMdV1)(customerName)}** tomonidan **${(0, formatters_1.formatCurrency)(payAmount, firstDebt.currency)}** to'lov qabul qilindi!\n\n${suffix}`, {
            parse_mode: 'Markdown',
            reply_markup: new grammy_1.InlineKeyboard().text("👥 Nasiyadorlar ro'yxatiga qaytish", 'debt:back'),
        });
    }
});
exports.debtHandler.callbackQuery('debt:new', async (ctx) => {
    ctx.session.step = 'ADD_DEBT_TEMPLATE';
    await ctx.reply(`👇 **"Shablonni to'ldirish"** tugmasini bosing yoki shunchaki oddiy matnda yozing (masalan: \`Alisher 120000 non va yog'\`)!`, {
        parse_mode: 'Markdown',
        reply_markup: new grammy_1.InlineKeyboard().switchInlineCurrent("✍️ Shablonni to'ldirish", `Operatsiya: Nasiya\nMijoz: \nSumma: \nTelefon: \nIzoh: `),
    });
});
exports.debtHandler.on('message:text', async (ctx, next) => {
    if (ctx.session.step === 'DEBT_PAYMENT' && ctx.from) {
        const ownerId = String(ctx.from.id);
        const rawText = ctx.message.text.trim();
        if (rawText.startsWith('/') || (0, menu_1.isMenuButton)(rawText)) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const customerName = ctx.session.tempData?.customerName;
        if (!customerName) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const { amount: payAmount, currency } = (0, formatters_1.parseCurrencyAndAmount)(rawText);
        if (!payAmount || payAmount <= 0 || isNaN(payAmount)) {
            return ctx.reply("❌ To'g'ri to'lov summasini kiriting (masalan: 50000, 50 ming yoki $25.50). To'xtatish uchun /start.");
        }
        const remainingTotal = await applyCustomerPaymentFIFO(ownerId, customerName, payAmount, currency);
        (0, telegram_1.clearSession)(ctx);
        const suffix = remainingTotal > 0
            ? `💰 **Qolgan nasiya summasi:** ${(0, formatters_1.formatCurrency)(remainingTotal, currency)}`
            : `🎉 **${(0, telegram_1.sanitizeMdV1)(customerName)} barcha qarzlarini to'liq yopdi!**`;
        return (0, telegram_1.safeReply)(ctx, `✅ **${(0, telegram_1.sanitizeMdV1)(customerName)}** tomonidan **${(0, formatters_1.formatCurrency)(payAmount, currency)}** to'lov qabul qilindi!\n\n${suffix}`, {
            parse_mode: 'Markdown',
            reply_markup: new grammy_1.InlineKeyboard().text("👥 Nasiyadorlar ro'yxatiga qaytish", 'debt:back'),
        });
    }
    if (ctx.session.step !== 'ADD_DEBT_TEMPLATE')
        return next();
    const text = ctx.message.text;
    if (!text.includes('Operatsiya: Nasiya') && !text.includes('Mijoz:')) {
        ctx.session.step = undefined;
        return next();
    }
    const customerName = text.match(/Mijoz:\s*([^\n]+)/i)?.[1]?.trim() || '';
    const rawSummaLine = text.match(/Summa:\s*([^\n]+)/i)?.[1] || '';
    const { amount, currency } = (0, formatters_1.parseCurrencyAndAmount)(rawSummaLine);
    const phone = text.match(/Telefon:\s*([^\n]+)/i)?.[1]?.trim() || '';
    const note = text.match(/Izoh:\s*([\s\S]+)/i)?.[1]?.trim() || '';
    if (!customerName)
        return ctx.reply("❌ Mijoz ismini aniqlab bo'lmadi.");
    if (!amount)
        return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");
    const actionId = `debt_conf_${Date.now()}`;
    ctx.session.tempData = { type: 'DEBT_TEMPLATE', data: { amount, currency, customerName, phone, note } };
    ctx.session.step = actionId;
    const confirmText = `🧾 *Nasiya Tahlili:*\n▫️ *Operatsiya:* Nasiya savdo\n▫️ *Mijoz:* ${customerName}\n▫️ *Summa:* ${(0, formatters_1.formatCurrency)(amount, currency)}\n${phone ? `▫️ *Telefon:* ${phone}\n` : ''}${note ? `▫️ *Izoh:* ${note}\n` : ''}\nMa'lumotlar to'g'rimi?`;
    await ctx.reply(confirmText, {
        parse_mode: 'Markdown',
        reply_markup: (0, inline_1.getTemplateConfirmKeyboard)('debt:edit', actionId),
    });
});
(0, telegram_1.registerTemplateActions)(exports.debtHandler, 'debt', 'ADD_DEBT_TEMPLATE', 'DEBT_TEMPLATE', async (ctx, { amount, currency = 'UZS', customerName, phone, note }) => {
    const ownerId = String(ctx.from?.id || '');
    const cleanCust = (0, transliterate_1.toLatinUz)(customerName);
    await prisma_1.prisma.customerDebt.create({
        data: { ownerId, customerName: cleanCust, amount, currency, phone: phone || null, itemsSummary: note ? (0, transliterate_1.toLatinUz)(note) : null },
    });
    const agg = await prisma_1.prisma.customerDebt.aggregate({
        where: { ownerId, customerName: cleanCust, currency },
        _sum: { amount: true, paidAmount: true },
    });
    const totalRemaining = Number((Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0)).toFixed(2));
    return `✅ Nasiya saqlandi: ${cleanCust} (+${(0, formatters_1.formatCurrency)(amount, currency)})\n💰 Yangilangan umumiy qarz: ${(0, formatters_1.formatCurrency)(totalRemaining, currency)}${note ? `\n📝 Izoh: ${(0, transliterate_1.toLatinUz)(note)}` : ''}`;
});
