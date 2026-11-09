"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closingHandler = void 0;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const formatters_1 = require("../../utils/formatters");
const inline_1 = require("../keyboards/inline");
const telegram_1 = require("../../utils/telegram");
exports.closingHandler = new grammy_1.Composer();
exports.closingHandler.hears('📊 Z-Hisobot (Kunlik)', async (ctx) => {
    if (ctx.user?.role !== 'OWNER')
        return;
    const existing = await prisma_1.prisma.dailyRegister.findUnique({ where: { date: (0, formatters_1.getToday)() } });
    if (existing?.isClosed)
        return ctx.reply(`Bugungi kassa yopilgan. Naqd: ${(0, formatters_1.formatMoney)(existing.cashUzs)}`);
    ctx.session.step = 'Z_REPORT_CASH';
    await ctx.reply('Bugungi **Naqd pul** (UZS) miqdorini kiriting:', { parse_mode: 'Markdown' });
});
exports.closingHandler.on('message:text', async (ctx, next) => {
    if (!ctx.session.step?.startsWith('Z_REPORT_'))
        return next();
    const amount = Number(ctx.message.text.replace(/[^0-9]/g, ''));
    if (isNaN(amount))
        return ctx.reply('Faqat raqam kiriting!');
    if (ctx.session.step === 'Z_REPORT_CASH') {
        ctx.session.tempData = { cashUzs: amount };
        ctx.session.step = 'Z_REPORT_CLICK';
        return ctx.reply('Endi **Click** orqali tushgan pulni kiriting:', { parse_mode: 'Markdown' });
    }
    if (ctx.session.step === 'Z_REPORT_CLICK') {
        ctx.session.tempData.clickAmount = amount;
        ctx.session.step = 'Z_REPORT_TERMINAL';
        return ctx.reply('Endi **Terminal** orqali tushgan pulni kiriting:', { parse_mode: 'Markdown' });
    }
    if (ctx.session.step === 'Z_REPORT_TERMINAL') {
        const d = ctx.session.tempData;
        d.terminalAmount = amount;
        const actionId = `zrep_${Date.now()}`;
        ctx.session.step = actionId;
        const total = d.cashUzs + d.clickAmount + d.terminalAmount;
        await ctx.reply(`📊 **Z-Hisobot tasdiqlash**\n\nNaqd: ${(0, formatters_1.formatMoney)(d.cashUzs)}\nClick: ${(0, formatters_1.formatMoney)(d.clickAmount)}\nTerminal: ${(0, formatters_1.formatMoney)(d.terminalAmount)}\n\nJami: ${(0, formatters_1.formatMoney)(total)}\n\nYopaymi?`, { parse_mode: 'Markdown', reply_markup: (0, inline_1.getConfirmationKeyboard)(actionId) });
    }
});
exports.closingHandler.callbackQuery(/^confirm_zrep_/, async (ctx) => {
    const d = ctx.session.tempData;
    if (!d)
        return ctx.answerCallbackQuery({ text: "Eskirgan so'rov!", show_alert: true });
    const date = (0, formatters_1.getToday)();
    const payload = { cashUzs: d.cashUzs, clickAmount: d.clickAmount, terminalAmount: d.terminalAmount, isClosed: true };
    try {
        await prisma_1.prisma.dailyRegister.upsert({ where: { date }, update: payload, create: { date, ...payload } });
        await ctx.editMessageText('✅ Kassa muvaffaqiyatli yopildi!');
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
