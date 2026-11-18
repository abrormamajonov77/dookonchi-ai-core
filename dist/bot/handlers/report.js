"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportHandler = void 0;
exports.getReportKeyboard = getReportKeyboard;
const grammy_1 = require("grammy");
const report_service_1 = require("../../services/report.service");
const export_service_1 = require("../../services/export.service");
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
        .text('📥 Excel (.csv) yuklab olish', 'export:excel')
        .text('📄 PDF hisobot yuklab olish', 'export:pdf')
        .row()
        .text('🔄 Yangilash', `rep:p:${activePeriod}`)
        .text('🔙 Asosiy', 'menu:main');
}
async function sendPeriodReport(ctx, period, isEdit = false) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    try {
        const text = await report_service_1.ReportService.generateReport(period, new Date(), ownerId);
        const kb = getReportKeyboard(period);
        await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
    }
    catch (error) {
        logger_1.logger.error({ error, period, ownerId }, 'Error generating periodic report');
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({ text: 'Hisobotni shakllantirishda xatolik yuz berdi.', show_alert: true });
        }
        else {
            await ctx.reply('❌ Hisobotni shakllantirishda xatolik yuz berdi.');
        }
    }
}
async function sendOwnerDatabaseExports(ctx, mode = 'all') {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    await (0, telegram_1.withChatAction)(ctx, 'upload_document', async () => {
        try {
            const exported = await export_service_1.ExportService.exportOwnerDatabase(ownerId);
            const captionSummary = `📊 **Shaxsiy bazangiz hisoboti tayyor!**\n` +
                `• Ta'minotchilar: **${exported.suppliers.length} ta**\n` +
                `• Nakladnoylar: **${exported.invoices.length} ta**\n` +
                `• Z-Otchyotlar: **${exported.zReports.length} ta**`;
            if (mode === 'all' || mode === 'excel') {
                await ctx.replyWithDocument(new grammy_1.InputFile(exported.excelBuffer, exported.excelFilename), {
                    caption: `📥 **Excel (.csv) Jadval**\n${captionSummary}`,
                    parse_mode: 'Markdown',
                });
            }
            if (mode === 'all' || mode === 'pdf') {
                await ctx.replyWithDocument(new grammy_1.InputFile(exported.pdfBuffer, exported.pdfFilename), {
                    caption: `📄 **PDF Hisobot**\n${captionSummary}`,
                    parse_mode: 'Markdown',
                });
            }
        }
        catch (error) {
            logger_1.logger.error({ error, ownerId }, 'Error exporting database');
            await ctx.reply('❌ Bazani yuklab olishda xatolik yuz berdi.');
        }
    });
}
exports.reportHandler.hears('📈 Davriy Hisobot', async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    const defaultPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
    await sendPeriodReport(ctx, defaultPeriod, false);
});
exports.reportHandler.hears('📥 Bazani yuklab olish (Excel / PDF)', async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await sendOwnerDatabaseExports(ctx, 'all');
});
exports.reportHandler.command(['report', 'hisobot'], async (ctx) => {
    const defaultPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
    await sendPeriodReport(ctx, defaultPeriod, false);
});
exports.reportHandler.command('export', async (ctx) => {
    await sendOwnerDatabaseExports(ctx, 'all');
});
exports.reportHandler.callbackQuery(/^rep:p:(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    if (!VALID_PERIODS.includes(period)) {
        return ctx.answerCallbackQuery({ text: "Noto'g'ri davr tanlandi." });
    }
    await sendPeriodReport(ctx, period, true);
});
exports.reportHandler.callbackQuery('export:excel', async (ctx) => {
    await sendOwnerDatabaseExports(ctx, 'excel');
});
exports.reportHandler.callbackQuery('export:pdf', async (ctx) => {
    await sendOwnerDatabaseExports(ctx, 'pdf');
});
exports.reportHandler.callbackQuery('export:all', async (ctx) => {
    await sendOwnerDatabaseExports(ctx, 'all');
});
