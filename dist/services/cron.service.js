"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCronJobs = startCronJobs;
const node_cron_1 = __importDefault(require("node-cron"));
const prisma_1 = require("../database/prisma");
const env_1 = require("../config/env");
const logger_1 = require("../config/logger");
const formatters_1 = require("../utils/formatters");
const report_service_1 = require("./report.service");
const report_1 = require("../bot/handlers/report");
function startCronJobs(bot) {
    const opts = { timezone: 'Asia/Tashkent' };
    const notifyOwner = (text, replyMarkup) => bot.api.sendMessage(env_1.env.OWNER_TELEGRAM_ID, text, {
        parse_mode: 'Markdown',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    // Har dushanba ertalab soat 08:00 da — O'tgan haftaning to'liq moliyaviy hisoboti
    node_cron_1.default.schedule('0 8 * * 1', async () => {
        logger_1.logger.info('Running cron: 08:00 Monday Weekly Financial Report');
        try {
            const reportText = await report_service_1.ReportService.generateReport('last_week');
            await notifyOwner(reportText, (0, report_1.getReportKeyboard)('last_week'));
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send weekly financial report');
        }
    }, opts);
    // Har oyning 1-sanasida ertalab soat 08:00 da — O'tgan oyning to'liq moliyaviy hisoboti
    node_cron_1.default.schedule('0 8 1 * *', async () => {
        logger_1.logger.info('Running cron: 08:00 Monthly Financial Report');
        try {
            const reportText = await report_service_1.ReportService.generateReport('last_month');
            await notifyOwner(reportText, (0, report_1.getReportKeyboard)('last_month'));
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send monthly financial report');
        }
    }, opts);
    // Har kuni soat 09:00 da — 7 kundan oshgan eski nasiyalar eslatmasi
    node_cron_1.default.schedule('0 9 * * *', async () => {
        logger_1.logger.info('Running cron: 09:00 Pending Debts');
        try {
            const oldDebts = await prisma_1.prisma.customerDebt.findMany({
                where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] }, createdAt: { lte: new Date(Date.now() - 7 * 86400000) } }
            });
            if (oldDebts.length) {
                const lines = oldDebts.map(d => `- ${d.customerName}: ${(0, formatters_1.formatMoney)(Number(d.amount) - Number(d.paidAmount), d.currency)}`);
                await notifyOwner(`⚠️ **Eski Nasiyalar (7 kundan oshgan)**\n\n${lines.join('\n')}`);
            }
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send pending debts cron');
        }
    }, opts);
    // Har kuni soat 20:00 da — Kassa yopilmagan bo'lsa eslatma
    node_cron_1.default.schedule('0 20 * * *', async () => {
        logger_1.logger.info('Running cron: 20:00 Z-Report Reminder');
        try {
            const register = await prisma_1.prisma.dailyRegister.findUnique({ where: { date: (0, formatters_1.getToday)() } });
            if (!register?.isClosed) {
                for (const u of await prisma_1.prisma.user.findMany()) {
                    await bot.api.sendMessage(Number(u.telegramId), '⏰ Diqqat! Bugungi kassa hali yopilmagan. Iltimos Z-Hisobotni topshiring.').catch(() => { });
                }
            }
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send Z-Report reminder');
        }
    }, opts);
    // Har kuni soat 21:00 da — Kunlik yakuniy hisobot
    node_cron_1.default.schedule('0 21 * * *', async () => {
        logger_1.logger.info('Running cron: 21:00 Daily Summary');
        try {
            const r = await prisma_1.prisma.dailyRegister.findUnique({ where: { date: (0, formatters_1.getToday)() } });
            const body = r
                ? `Naqd: ${(0, formatters_1.formatMoney)(r.cashUzs)}\nClick: ${(0, formatters_1.formatMoney)(r.clickAmount)}\nTerminal: ${(0, formatters_1.formatMoney)(r.terminalAmount)}\nKassa Yopilgan: ${r.isClosed ? 'HA' : "YO'Q"}\n`
                : "Bugun kassa ma'lumotlari kiritilmadi!\n";
            await notifyOwner(`📊 **Kunlik Yakuniy Hisobot**\n\n${body}`);
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send daily summary');
        }
    }, opts);
}
