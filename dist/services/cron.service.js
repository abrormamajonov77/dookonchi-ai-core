"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCronJobs = startCronJobs;
const node_cron_1 = __importDefault(require("node-cron"));
const prisma_1 = require("../database/prisma");
const logger_1 = require("../config/logger");
const formatters_1 = require("../utils/formatters");
const telegram_1 = require("../utils/telegram");
const report_service_1 = require("./report.service");
const subscription_service_1 = require("./subscription.service");
const report_1 = require("../bot/handlers/report");
function startCronJobs(bot) {
    const opts = { timezone: 'Asia/Tashkent' };
    const getActiveStoreUsers = async () => {
        return prisma_1.prisma.user.findMany({
            where: { status: 'ACTIVE' },
            select: { telegramId: true },
        });
    };
    // Har 6 soatda — Obuna muddati <= 3 kun qolganlar, tugaganlarni tekshirish + 24 soatdan eski PendingAction larni tozalash
    node_cron_1.default.schedule('0 */6 * * *', async () => {
        logger_1.logger.info('Running cron: Subscription Expiry, 3-Day Reminder & Stale PendingAction Cleanup');
        try {
            await Promise.all([
                subscription_service_1.SubscriptionService.checkExpiringAndExpiredSubscriptions((targetId, text, replyMarkup) => bot.api.sendMessage(targetId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined)),
                prisma_1.prisma.pendingAction
                    .deleteMany({
                    where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
                })
                    .catch(() => { }),
            ]);
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to run subscription check cron');
        }
    }, opts);
    // Har dushanba ertalab soat 08:00 da — Har bir faol obunachiga o'zining o'tgan haftalik hisoboti
    node_cron_1.default.schedule('0 8 * * 1', async () => {
        logger_1.logger.info('Running cron: 08:00 Monday Weekly Financial Report');
        try {
            const users = await getActiveStoreUsers();
            for (const u of users) {
                const reportText = await report_service_1.ReportService.generateReport('last_week', new Date(), u.telegramId);
                await bot.api
                    .sendMessage(u.telegramId, reportText, {
                    parse_mode: 'Markdown',
                    reply_markup: (0, report_1.getReportKeyboard)('last_week'),
                })
                    .catch(() => { });
            }
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send weekly financial report');
        }
    }, opts);
    // Har oyning 1-sanasida ertalab soat 08:00 da — Har bir faol obunachiga o'zining o'tgan oylik hisoboti
    node_cron_1.default.schedule('0 8 1 * *', async () => {
        logger_1.logger.info('Running cron: 08:00 Monthly Financial Report');
        try {
            const users = await getActiveStoreUsers();
            for (const u of users) {
                const reportText = await report_service_1.ReportService.generateReport('last_month', new Date(), u.telegramId);
                await bot.api
                    .sendMessage(u.telegramId, reportText, {
                    parse_mode: 'Markdown',
                    reply_markup: (0, report_1.getReportKeyboard)('last_month'),
                })
                    .catch(() => { });
            }
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send monthly financial report');
        }
    }, opts);
    // Har kuni soat 09:00 da — 7 kundan oshgan eski nasiyalar eslatmasi (har bir foydalanuvchi uchun alohida)
    node_cron_1.default.schedule('0 9 * * *', async () => {
        logger_1.logger.info('Running cron: 09:00 Pending Debts');
        try {
            const users = await getActiveStoreUsers();
            const cutoff = new Date(Date.now() - 7 * 86400000);
            for (const u of users) {
                const oldDebts = await prisma_1.prisma.customerDebt.findMany({
                    where: {
                        ownerId: u.telegramId,
                        status: { in: ['PENDING', 'PARTIALLY_PAID'] },
                        createdAt: { lte: cutoff },
                    },
                });
                if (oldDebts.length) {
                    const lines = oldDebts.map((d) => `- ${(0, telegram_1.sanitizeMdV1)(d.customerName)}: ${(0, formatters_1.formatMoney)(Number(d.amount) - Number(d.paidAmount), d.currency)}`);
                    await bot.api
                        .sendMessage(u.telegramId, `⚠️ **Eski Nasiyalar (7 kundan oshgan)**\n\n${lines.join('\n')}`, {
                        parse_mode: 'Markdown',
                    })
                        .catch(() => { });
                }
            }
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send pending debts cron');
        }
    }, opts);
    // Har kuni soat 20:00 da — Kassa yopilmagan bo'lsa eslatma (Toshkent UTC+5 dateKey)
    node_cron_1.default.schedule('0 20 * * *', async () => {
        logger_1.logger.info('Running cron: 20:00 Z-Report Reminder');
        try {
            const users = await getActiveStoreUsers();
            const { dateKey } = (0, formatters_1.getTashkentDayRange)();
            for (const u of users) {
                const register = await prisma_1.prisma.dailyRegister.findUnique({
                    where: { ownerId_date: { ownerId: u.telegramId, date: dateKey } },
                });
                if (!register?.isClosed) {
                    await bot.api
                        .sendMessage(u.telegramId, '⏰ Diqqat! Bugungi kassa hali yopilmagan. Iltimos Z-Hisobotni topshiring.')
                        .catch(() => { });
                }
            }
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send Z-Report reminder');
        }
    }, opts);
    // Har kuni soat 21:00 da — Kunlik yakuniy hisobot (Toshkent UTC+5 dateKey, har bir foydalanuvchi uchun alohida)
    node_cron_1.default.schedule('0 21 * * *', async () => {
        logger_1.logger.info('Running cron: 21:00 Daily Summary');
        try {
            const users = await getActiveStoreUsers();
            const { dateKey } = (0, formatters_1.getTashkentDayRange)();
            for (const u of users) {
                const [r, supAgg] = await Promise.all([
                    prisma_1.prisma.dailyRegister.findUnique({
                        where: { ownerId_date: { ownerId: u.telegramId, date: dateKey } },
                    }),
                    prisma_1.prisma.supplier.aggregate({
                        where: { ownerId: u.telegramId, isActive: true },
                        _sum: { debtUzs: true, debtUsd: true },
                    }),
                ]);
                const body = r
                    ? `Naqd (UZS): ${(0, formatters_1.formatMoney)(r.cashUzs, 'UZS')}\nClick: ${(0, formatters_1.formatMoney)(r.clickAmount, 'UZS')}\nTerminal: ${(0, formatters_1.formatMoney)(r.terminalAmount, 'UZS')}\nJami Savdo: ${(0, formatters_1.formatMoney)(r.totalDailySalesUzs || r.cashUzs, 'UZS')}\nKassa Yopilgan: ${r.isClosed ? 'HA' : "YO'Q"}\n\n📊 JAMI QARZ (UZS): ${(0, formatters_1.formatMoney)(supAgg._sum.debtUzs || 0, 'UZS')}\n💵 JAMI QARZ (USD/USDT): ${(0, formatters_1.formatMoney)(supAgg._sum.debtUsd || 0, 'USD')}\n`
                    : `Bugun kassa ma'lumotlari kiritilmadi!\n\n📊 JAMI QARZ (UZS): ${(0, formatters_1.formatMoney)(supAgg._sum.debtUzs || 0, 'UZS')}\n💵 JAMI QARZ (USD/USDT): ${(0, formatters_1.formatMoney)(supAgg._sum.debtUsd || 0, 'USD')}\n`;
                await bot.api
                    .sendMessage(u.telegramId, `📊 **Kunlik Yakuniy Hisobot**\n\n${body}`, {
                    parse_mode: 'Markdown',
                })
                    .catch(() => { });
            }
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to send daily summary');
        }
    }, opts);
}
