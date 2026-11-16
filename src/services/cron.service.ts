import cron from 'node-cron';
import { Bot } from 'grammy';
import { prisma } from '../database/prisma';
import { MyContext } from '../bot/context';
import { logger } from '../config/logger';
import { formatMoney, getToday } from '../utils/formatters';
import { ReportService } from './report.service';
import { SubscriptionService } from './subscription.service';
import { getReportKeyboard } from '../bot/handlers/report';

export function startCronJobs(bot: Bot<MyContext>) {
  const opts = { timezone: 'Asia/Tashkent' };

  const getActiveStoreUsers = async () => {
    return prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: { telegramId: true },
    });
  };

  // Har 6 soatda (va soat 10:00 da) — Obuna muddati <= 3 kun qolganlar va tugaganlarni avtomatik tekshirish
  cron.schedule(
    '0 */6 * * *',
    async () => {
      logger.info('Running cron: Subscription Expiry & 3-Day Reminder Check');
      try {
        await SubscriptionService.checkExpiringAndExpiredSubscriptions((targetId, text, replyMarkup) =>
          bot.api.sendMessage(targetId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined)
        );
      } catch (error) {
        logger.error({ error }, 'Failed to run subscription check cron');
      }
    },
    opts
  );

  // Har dushanba ertalab soat 08:00 da — Har bir faol obunachiga o'zining o'tgan haftalik hisoboti
  cron.schedule(
    '0 8 * * 1',
    async () => {
      logger.info('Running cron: 08:00 Monday Weekly Financial Report');
      try {
        const users = await getActiveStoreUsers();
        for (const u of users) {
          const reportText = await ReportService.generateReport('last_week', new Date(), u.telegramId);
          await bot.api
            .sendMessage(u.telegramId, reportText, {
              parse_mode: 'Markdown',
              reply_markup: getReportKeyboard('last_week'),
            })
            .catch(() => {});
        }
      } catch (error) {
        logger.error({ error }, 'Failed to send weekly financial report');
      }
    },
    opts
  );

  // Har oyning 1-sanasida ertalab soat 08:00 da — Har bir faol obunachiga o'zining o'tgan oylik hisoboti
  cron.schedule(
    '0 8 1 * *',
    async () => {
      logger.info('Running cron: 08:00 Monthly Financial Report');
      try {
        const users = await getActiveStoreUsers();
        for (const u of users) {
          const reportText = await ReportService.generateReport('last_month', new Date(), u.telegramId);
          await bot.api
            .sendMessage(u.telegramId, reportText, {
              parse_mode: 'Markdown',
              reply_markup: getReportKeyboard('last_month'),
            })
            .catch(() => {});
        }
      } catch (error) {
        logger.error({ error }, 'Failed to send monthly financial report');
      }
    },
    opts
  );

  // Har kuni soat 09:00 da — 7 kundan oshgan eski nasiyalar eslatmasi (har bir foydalanuvchi uchun alohida)
  cron.schedule(
    '0 9 * * *',
    async () => {
      logger.info('Running cron: 09:00 Pending Debts');
      try {
        const users = await getActiveStoreUsers();
        const cutoff = new Date(Date.now() - 7 * 86400000);
        for (const u of users) {
          const oldDebts = await prisma.customerDebt.findMany({
            where: {
              ownerId: u.telegramId,
              status: { in: ['PENDING', 'PARTIALLY_PAID'] },
              createdAt: { lte: cutoff },
            },
          });
          if (oldDebts.length) {
            const lines = oldDebts.map(
              (d) => `- ${d.customerName}: ${formatMoney(Number(d.amount) - Number(d.paidAmount), d.currency)}`
            );
            await bot.api
              .sendMessage(u.telegramId, `⚠️ **Eski Nasiyalar (7 kundan oshgan)**\n\n${lines.join('\n')}`, {
                parse_mode: 'Markdown',
              })
              .catch(() => {});
          }
        }
      } catch (error) {
        logger.error({ error }, 'Failed to send pending debts cron');
      }
    },
    opts
  );

  // Har kuni soat 20:00 da — Kassa yopilmagan bo'lsa eslatma
  cron.schedule(
    '0 20 * * *',
    async () => {
      logger.info('Running cron: 20:00 Z-Report Reminder');
      try {
        const users = await getActiveStoreUsers();
        const today = getToday();
        for (const u of users) {
          const register = await prisma.dailyRegister.findUnique({
            where: { ownerId_date: { ownerId: u.telegramId, date: today } },
          });
          if (!register?.isClosed) {
            await bot.api
              .sendMessage(
                u.telegramId,
                '⏰ Diqqat! Bugungi kassa hali yopilmagan. Iltimos Z-Hisobotni topshiring.'
              )
              .catch(() => {});
          }
        }
      } catch (error) {
        logger.error({ error }, 'Failed to send Z-Report reminder');
      }
    },
    opts
  );

  // Har kuni soat 21:00 da — Kunlik yakuniy hisobot (har bir foydalanuvchi uchun alohida)
  cron.schedule(
    '0 21 * * *',
    async () => {
      logger.info('Running cron: 21:00 Daily Summary');
      try {
        const users = await getActiveStoreUsers();
        const today = getToday();
        for (const u of users) {
          const [r, supAgg] = await Promise.all([
            prisma.dailyRegister.findUnique({
              where: { ownerId_date: { ownerId: u.telegramId, date: today } },
            }),
            prisma.supplier.aggregate({
              where: { ownerId: u.telegramId, isActive: true },
              _sum: { debtUzs: true, debtUsd: true },
            }),
          ]);
          const body = r
            ? `Naqd (UZS): ${formatMoney(r.cashUzs, 'UZS')}\nClick: ${formatMoney(r.clickAmount, 'UZS')}\nTerminal: ${formatMoney(r.terminalAmount, 'UZS')}\nJami Savdo: ${formatMoney(r.totalDailySalesUzs || r.cashUzs, 'UZS')}\nKassa Yopilgan: ${r.isClosed ? 'HA' : "YO'Q"}\n\n📊 JAMI QARZ (UZS): ${formatMoney(supAgg._sum.debtUzs || 0, 'UZS')}\n💵 JAMI QARZ (USD/USDT): ${formatMoney(supAgg._sum.debtUsd || 0, 'USD')}\n`
            : `Bugun kassa ma'lumotlari kiritilmadi!\n\n📊 JAMI QARZ (UZS): ${formatMoney(supAgg._sum.debtUzs || 0, 'UZS')}\n💵 JAMI QARZ (USD/USDT): ${formatMoney(supAgg._sum.debtUsd || 0, 'USD')}\n`;
          await bot.api
            .sendMessage(u.telegramId, `📊 **Kunlik Yakuniy Hisobot**\n\n${body}`, {
              parse_mode: 'Markdown',
            })
            .catch(() => {});
        }
      } catch (error) {
        logger.error({ error }, 'Failed to send daily summary');
      }
    },
    opts
  );
}
