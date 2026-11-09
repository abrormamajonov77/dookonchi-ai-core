import cron from 'node-cron';
import { Bot } from 'grammy';
import { prisma } from '../database/prisma';
import { env } from '../config/env';
import { MyContext } from '../bot/context';
import { logger } from '../config/logger';
import { formatMoney, getToday } from '../utils/formatters';
import { ReportService } from './report.service';
import { getReportKeyboard } from '../bot/handlers/report';

export function startCronJobs(bot: Bot<MyContext>) {
  const opts = { timezone: 'Asia/Tashkent' };
  const notifyOwner = (text: string, replyMarkup?: any) =>
    bot.api.sendMessage(env.OWNER_TELEGRAM_ID, text, {
      parse_mode: 'Markdown',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });

  // Har dushanba ertalab soat 08:00 da — O'tgan haftaning to'liq moliyaviy hisoboti
  cron.schedule('0 8 * * 1', async () => {
    logger.info('Running cron: 08:00 Monday Weekly Financial Report');
    try {
      const reportText = await ReportService.generateReport('last_week');
      await notifyOwner(reportText, getReportKeyboard('last_week'));
    } catch (error) {
      logger.error({ error }, 'Failed to send weekly financial report');
    }
  }, opts);

  // Har oyning 1-sanasida ertalab soat 08:00 da — O'tgan oyning to'liq moliyaviy hisoboti
  cron.schedule('0 8 1 * *', async () => {
    logger.info('Running cron: 08:00 Monthly Financial Report');
    try {
      const reportText = await ReportService.generateReport('last_month');
      await notifyOwner(reportText, getReportKeyboard('last_month'));
    } catch (error) {
      logger.error({ error }, 'Failed to send monthly financial report');
    }
  }, opts);

  // Har kuni soat 09:00 da — 7 kundan oshgan eski nasiyalar eslatmasi
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running cron: 09:00 Pending Debts');
    try {
      const oldDebts = await prisma.customerDebt.findMany({
        where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] }, createdAt: { lte: new Date(Date.now() - 7 * 86400000) } }
      });
      if (oldDebts.length) {
        const lines = oldDebts.map(d => `- ${d.customerName}: ${formatMoney(Number(d.amount) - Number(d.paidAmount), d.currency)}`);
        await notifyOwner(`⚠️ **Eski Nasiyalar (7 kundan oshgan)**\n\n${lines.join('\n')}`);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to send pending debts cron');
    }
  }, opts);

  // Har kuni soat 20:00 da — Kassa yopilmagan bo'lsa eslatma
  cron.schedule('0 20 * * *', async () => {
    logger.info('Running cron: 20:00 Z-Report Reminder');
    try {
      const register = await prisma.dailyRegister.findUnique({ where: { date: getToday() } });
      if (!register?.isClosed) {
        for (const u of await prisma.user.findMany()) {
          await bot.api.sendMessage(Number(u.telegramId), '⏰ Diqqat! Bugungi kassa hali yopilmagan. Iltimos Z-Hisobotni topshiring.').catch(() => { });
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to send Z-Report reminder');
    }
  }, opts);

  // Har kuni soat 21:00 da — Kunlik yakuniy hisobot
  cron.schedule('0 21 * * *', async () => {
    logger.info('Running cron: 21:00 Daily Summary');
    try {
      const r = await prisma.dailyRegister.findUnique({ where: { date: getToday() } });
      const body = r
        ? `Naqd: ${formatMoney(r.cashUzs)}\nClick: ${formatMoney(r.clickAmount)}\nTerminal: ${formatMoney(r.terminalAmount)}\nKassa Yopilgan: ${r.isClosed ? 'HA' : "YO'Q"}\n`
        : "Bugun kassa ma'lumotlari kiritilmadi!\n";
      await notifyOwner(`📊 **Kunlik Yakuniy Hisobot**\n\n${body}`);
    } catch (error) {
      logger.error({ error }, 'Failed to send daily summary');
    }
  }, opts);
}
