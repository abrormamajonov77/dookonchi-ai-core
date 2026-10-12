import cron from 'node-cron';
import { prisma } from '../database/prisma';
import { env } from '../config/env';
import { Bot } from 'grammy';
import { MyContext } from '../bot/context';
import { logger } from '../config/logger';
import { formatMoney } from '../utils/formatters';

export function startCronJobs(bot: Bot<MyContext>) {
  const TIMEZONE = 'Asia/Tashkent';

  // 09:00 - Pending debts > 7 days notification
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running cron: 09:00 Pending Debts');
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const oldDebts = await prisma.customerDebt.findMany({
      where: { 
        status: { in: ['PENDING', 'PARTIALLY_PAID'] },
        createdAt: { lte: sevenDaysAgo }
      }
    });

    if (oldDebts.length > 0) {
      let text = `⚠️ **Eski Nasiyalar (7 kundan oshgan)**\n\n`;
      oldDebts.forEach((d: any) => {
        text += `- ${d.customerName}: ${formatMoney(Number(d.amount) - Number(d.paidAmount), d.currency)}\n`;
      });
      await bot.api.sendMessage(env.OWNER_TELEGRAM_ID, text, { parse_mode: 'Markdown' });
    }
  }, { timezone: TIMEZONE });

  // 20:00 - Reminder to submit Z-Report
  cron.schedule('0 20 * * *', async () => {
    logger.info('Running cron: 20:00 Z-Report Reminder');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const register = await prisma.dailyRegister.findUnique({
      where: { date: today }
    });

    if (!register || !register.isClosed) {
      // Notify all sellers and owner
      const users = await prisma.user.findMany();
      for (const u of users) {
        try {
          await bot.api.sendMessage(Number(u.telegramId), "⏰ Diqqat! Bugungi kassa hali yopilmagan. Iltimos Z-Hisobotni topshiring.");
        } catch (e) {}
      }
    }
  }, { timezone: TIMEZONE });

  // 21:00 - Automated summary Z-Report calculation
  cron.schedule('0 21 * * *', async () => {
    logger.info('Running cron: 21:00 Daily Summary');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const register = await prisma.dailyRegister.findUnique({
      where: { date: today }
    });

    let text = `📊 **Kunlik Yakuniy Hisobot**\n\n`;
    if (register) {
      text += `Naqd: ${formatMoney(register.cashUzs)}\n`;
      text += `Click: ${formatMoney(register.clickAmount)}\n`;
      text += `Terminal: ${formatMoney(register.terminalAmount)}\n`;
      text += `Kassa Yopilgan: ${register.isClosed ? 'HA' : 'YO\'Q'}\n`;
    } else {
      text += `Bugun kassa ma'lumotlari kiritilmadi!\n`;
    }

    await bot.api.sendMessage(env.OWNER_TELEGRAM_ID, text, { parse_mode: 'Markdown' });
  }, { timezone: TIMEZONE });

  // 1st of Month 08:00 - Monthly expenses report
  cron.schedule('0 8 1 * *', async () => {
    logger.info('Running cron: Monthly expenses');
    const today = new Date();
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);

    const expenses = await prisma.expense.findMany({
      where: { createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } }
    });

    let total = 0;
    const byCategory: Record<string, number> = {};
    for (const exp of expenses) {
      const amt = Number(exp.amount);
      total += amt;
      byCategory[exp.category] = (byCategory[exp.category] || 0) + amt;
    }

    let text = `📅 **O'tgan oy xarajatlari:**\n\n`;
    for (const [cat, sum] of Object.entries(byCategory)) {
      text += `🔹 ${cat}: ${formatMoney(sum)}\n`;
    }
    text += `\n**Jami: ${formatMoney(total)}**`;

    await bot.api.sendMessage(env.OWNER_TELEGRAM_ID, text, { parse_mode: 'Markdown' });
  }, { timezone: TIMEZONE });
}
