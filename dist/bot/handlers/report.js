"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportHandler = void 0;
exports.getReportKeyboard = getReportKeyboard;
const grammy_1 = require("grammy");
const report_service_1 = require("../../services/report.service");
const telegram_1 = require("../../utils/telegram");
const logger_1 = require("../../config/logger");
exports.reportHandler = new grammy_1.Composer();
const VALID_PERIODS = ['current_week', 'last_week', 'current_month', 'last_month'];
function getReportKeyboard(activePeriod) {
    return new grammy_1.InlineKeyboard()
        .text(activePeriod === 'current_week' ? '✅ Shu hafta' : '📅 Shu hafta', 'rep:p:current_week')
        .text(activePeriod === 'last_week' ? "✅ O'tgan hafta" : "⏪ O'tgan hafta", 'rep:p:last_week')
        .row()
        .text(activePeriod === 'current_month' ? '✅ Shu oy' : '📆 Shu oy', 'rep:p:current_month')
        .text(activePeriod === 'last_month' ? "✅ O'tgan oy" : "⏮ O'tgan oy", 'rep:p:last_month')
        .row()
        .text('🔄 Yangilash', `rep:p:${activePeriod}`)
        .text('🔙 Asosiy', 'menu:main');
}
async function sendPeriodReport(ctx, period, isEdit = false) {
    if (ctx.user?.role !== 'OWNER') {
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({ text: "Sizda ushbu amal uchun huquq yo'q!", show_alert: true });
        }
        return;
    }
    try {
        const text = await report_service_1.ReportService.generateReport(period);
        const kb = getReportKeyboard(period);
        await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
    }
    catch (error) {
        logger_1.logger.error({ error, period }, 'Error generating periodic report');
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({ text: 'Hisobotni shakllantirishda xatolik yuz berdi.', show_alert: true });
        }
        else {
            await ctx.reply('❌ Hisobotni shakllantirishda xatolik yuz berdi.');
        }
    }
}
exports.reportHandler.hears('📈 Davriy Hisobot', async (ctx) => {
    if (ctx.user?.role !== 'OWNER')
        return;
    const defaultPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
    await sendPeriodReport(ctx, defaultPeriod, false);
});
exports.reportHandler.command(['report', 'hisobot'], async (ctx) => {
    if (ctx.user?.role !== 'OWNER')
        return;
    const defaultPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
    await sendPeriodReport(ctx, defaultPeriod, false);
});
exports.reportHandler.callbackQuery(/^rep:p:(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    if (!VALID_PERIODS.includes(period)) {
        return ctx.answerCallbackQuery({ text: "Noto'g'ri davr tanlandi." });
    }
    await sendPeriodReport(ctx, period, true);
});
