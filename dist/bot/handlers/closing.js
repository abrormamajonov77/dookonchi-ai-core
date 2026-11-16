"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closingHandler = void 0;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const formatters_1 = require("../../utils/formatters");
const inline_1 = require("../keyboards/inline");
const telegram_1 = require("../../utils/telegram");
const report_service_1 = require("../../services/report.service");
exports.closingHandler = new grammy_1.Composer();
exports.closingHandler.hears('📊 Z-Hisobot (Kunlik)', async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const { dateKey } = (0, formatters_1.getTashkentDayRange)();
    const existing = await prisma_1.prisma.dailyRegister.findUnique({
        where: { ownerId_date: { ownerId, date: dateKey } },
    });
    if (existing?.isClosed) {
        return ctx.reply(`✅ Bugungi kassa allaqachon yopilgan.\n💰 Bugungi jami savdo: **${(0, formatters_1.formatSom)(existing.totalDailySalesUzs || existing.cashUzs)}**`, { parse_mode: 'Markdown' });
    }
    ctx.session.step = 'Z_REPORT_TERMINAL';
    ctx.session.tempData = {};
    await ctx.reply("1️⃣ 💳 Bugungi **Terminal** savdosi summasini kiriting (yo'q bo'lsa `0` yozing):", {
        parse_mode: 'Markdown',
    });
});
exports.closingHandler.on('message:text', async (ctx, next) => {
    if (!ctx.session.step?.startsWith('Z_REPORT_') || !ctx.from)
        return next();
    const ownerId = String(ctx.from.id);
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/'))
        return next();
    const parsed = (0, formatters_1.parseCurrencyAndAmount)(rawText);
    const amount = rawText === '0' ? 0 : parsed.amount;
    if (isNaN(amount) || amount < 0)
        return ctx.reply('❌ Iltimos, faqat musbat raqam (yoki 0) kiriting!');
    if (ctx.session.step === 'Z_REPORT_TERMINAL') {
        ctx.session.tempData = { terminalAmount: amount };
        ctx.session.step = 'Z_REPORT_CLICK';
        return ctx.reply("2️⃣ 📱 Bugungi **Click / Payme / Uzum** savdosi summasini kiriting (yo'q bo'lsa `0` yozing):", {
            parse_mode: 'Markdown',
        });
    }
    if (ctx.session.step === 'Z_REPORT_CLICK') {
        ctx.session.tempData.clickAmount = amount;
        ctx.session.step = 'Z_REPORT_CASH';
        return ctx.reply("3️⃣ 💵 **Kassada qolgan sof naqd pul** (UZS) miqdorini kiriting (yo'q bo'lsa `0` yozing):", {
            parse_mode: 'Markdown',
        });
    }
    if (ctx.session.step === 'Z_REPORT_CASH') {
        const d = ctx.session.tempData || {};
        d.cashRemainingInDrawer = amount;
        const { startOfDay, endOfDay } = (0, formatters_1.getTashkentDayRange)();
        const [cashInvoices, supplierPayments] = await Promise.all([
            prisma_1.prisma.invoice.findMany({
                where: {
                    ownerId,
                    createdAt: { gte: startOfDay, lte: endOfDay },
                    currency: 'UZS',
                    paidCashAmount: { gt: 0 },
                },
                select: { paidCashAmount: true },
            }),
            prisma_1.prisma.supplierPayment.findMany({
                where: {
                    ownerId,
                    createdAt: { gte: startOfDay, lte: endOfDay },
                    currency: 'UZS',
                },
                select: { amount: true },
            }),
        ]);
        const dailyCashPurchasesUzs = cashInvoices.reduce((s, i) => s + Number(i.paidCashAmount || 0), 0);
        const dailySupplierPaymentsUzs = supplierPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
        const totalDailySalesUzs = Number(d.terminalAmount || 0) +
            Number(d.clickAmount || 0) +
            Number(d.cashRemainingInDrawer || 0) +
            dailyCashPurchasesUzs +
            dailySupplierPaymentsUzs;
        const actionId = `zrep_${Date.now()}`;
        ctx.session.step = actionId;
        const previewText = [
            `📊 **KUNLIK Z-OTCHYOT TASDIQLASH**`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `💳 Terminalda savdo: ${(0, formatters_1.formatSom)(d.terminalAmount)}`,
            `📱 Click / Karta savdo: ${(0, formatters_1.formatSom)(d.clickAmount)}`,
            `💵 Kassada qolgan naqd pul: ${(0, formatters_1.formatSom)(d.cashRemainingInDrawer)}`,
            `📦 Naqd pulga sotib olingan tovarlar (avto): ${(0, formatters_1.formatSom)(dailyCashPurchasesUzs)} (${cashInvoices.length} ta nakladnoy)`,
            `🤝 Ta'minotchilarga berilgan pul (avto): ${(0, formatters_1.formatSom)(dailySupplierPaymentsUzs)} (${supplierPayments.length} ta to'lov)`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `💰 **KUN DAVOMIDA JAMI SAVDO: ${(0, formatters_1.formatSom)(totalDailySalesUzs)}**`,
            ``,
            `Kassani yopaymi?`,
        ].join('\n');
        await ctx.reply(previewText, {
            parse_mode: 'Markdown',
            reply_markup: (0, inline_1.getConfirmationKeyboard)(actionId),
        });
    }
});
exports.closingHandler.callbackQuery(/^confirm_zrep_/, async (ctx) => {
    const d = ctx.session.tempData;
    if (!d || !ctx.from)
        return ctx.answerCallbackQuery({ text: "Eskirgan so'rov!", show_alert: true });
    const ownerId = String(ctx.from.id);
    try {
        const zReport = await report_service_1.ReportService.generateAndSaveZReport({
            ownerId,
            terminalAmount: Number(d.terminalAmount || 0),
            clickAmount: Number(d.clickAmount || 0),
            cashRemainingInDrawer: Number(d.cashRemainingInDrawer ?? d.cashUzs ?? 0),
        });
        await ctx.editMessageText(zReport.formattedText);
    }
    catch {
        await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi.', show_alert: true });
    }
    finally {
        (0, telegram_1.clearSession)(ctx);
    }
});
exports.closingHandler.callbackQuery(/^cancel_zrep_/, async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await ctx.editMessageText('❌ Z-Hisobot bekor qilindi.');
});
