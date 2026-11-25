import cron from 'node-cron';
import { Bot } from 'grammy';
import { prisma } from '../database/prisma';
import { MyContext } from '../bot/context';
import { logger } from '../config/logger';
import { formatMoney, formatSom, formatUsd, getTashkentDayRange } from '../utils/formatters';
import { sanitizeMdV1 } from '../utils/telegram';
import { ReportService } from './report.service';
import { SubscriptionService } from './subscription.service';
import {
  getRestockCyclesAndPaymentCalendar,
  RestockAndPaymentCalendarResult,
} from './dashboard.service';
import { getReportKeyboard } from '../bot/handlers/report';

/**
 * Builds the 09:00 Payment Day Reminder message for suppliers whose dominant payment
 * weekday matches today AND who currently have non-zero positive debt.
 */
export function buildDailyPaymentReminderMessage(
  data: RestockAndPaymentCalendarResult
): string | null {
  const todayDay = data.paymentCalendar.find((d) => d.weekday === data.todayWeekday);
  if (!todayDay) return null;

  const suppliersWithDebt = todayDay.suppliers.filter(
    (s) => s.debtUzs > 0.001 || s.debtUsd > 0.001
  );
  if (suppliersWithDebt.length === 0) return null;

  const lines = suppliersWithDebt.map((s) => {
    const debtParts: string[] = [];
    if (s.debtUzs > 0.001) debtParts.push(formatSom(s.debtUzs));
    if (s.debtUsd > 0.001) debtParts.push(formatUsd(s.debtUsd));
    return `• ${s.supplierName} — ${debtParts.join(' | ')}`;
  });

  return [
    `💳 Bugungi to'lov eslatmasi (${todayDay.fullLabel})`,
    '',
    "Odatda bugun pul oladigan ta'minotchilar va joriy qarzingiz:",
    ...lines,
    '',
    "To'lov qilsangiz, botga yozib yoki ovozli xabar yuborib qayd eting.",
  ].join('\n');
}

/**
 * Builds friendly 09:00 Restock Reminder messages for suppliers whose predicted
 * next delivery is tomorrow (daysUntilNext === 1) or in 2 days (daysUntilNext === 2).
 */
export function buildDailyRestockReminderMessages(
  data: RestockAndPaymentCalendarResult
): string[] {
  const upcoming = data.restockRadar.filter(
    (r) => r.daysUntilNext === 1 || r.daysUntilNext === 2
  );

  return upcoming.map((r) => {
    const timing = r.daysUntilNext === 1 ? 'Ertaga' : "2 kundan so'ng";
    return `📦 Yuk eslatmasi: ${timing} «${r.supplierName}»dan yuk olish vaqtingiz (o‘rtacha har ${r.avgCycleDays} kunda). Omborga razm soling, qaysi tovarlar kamayib qoldi?`;
  });
}

/**
 * Executes 09:00 smart Payment Day & Restock reminders for all ACTIVE store owners
 * with strict per-ownerId multi-tenant isolation.
 */
export async function runDailySmartReminders(bot: Bot<MyContext>, now: Date = new Date()) {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE' },
    select: { telegramId: true },
  });

  for (const u of users) {
    try {
      const ownerId = u.telegramId;
      const intelligence = await getRestockCyclesAndPaymentCalendar(ownerId, now);

      const paymentMessage = buildDailyPaymentReminderMessage(intelligence);
      if (paymentMessage) {
        await bot.api.sendMessage(ownerId, paymentMessage).catch(() => {});
      }

      const restockMessages = buildDailyRestockReminderMessages(intelligence);
      for (const restockMsg of restockMessages) {
        await bot.api.sendMessage(ownerId, restockMsg).catch(() => {});
      }
    } catch (error) {
      logger.error({ error, ownerId: u.telegramId }, 'Failed to send 09:00 smart reminder for owner');
    }
  }
}

export function startCronJobs(bot: Bot<MyContext>) {
  const opts = { timezone: 'Asia/Tashkent' };

  const getActiveStoreUsers = async () => {
    return prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: { telegramId: true },
    });
  };

  // Har 6 soatda — Obuna muddati <= 3 kun qolganlar, tugaganlarni tekshirish + 24 soatdan eski PendingAction larni tozalash
  cron.schedule(
    '0 */6 * * *',
    async () => {
      logger.info('Running cron: Subscription Expiry, 3-Day Reminder & Stale PendingAction Cleanup');
      try {
        await Promise.all([
          SubscriptionService.checkExpiringAndExpiredSubscriptions((targetId, text, replyMarkup) =>
            bot.api.sendMessage(targetId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined)
          ),
          prisma.pendingAction
            .deleteMany({
              where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            })
            .catch(() => {}),
        ]);
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
              (d) =>
                `- ${sanitizeMdV1(d.customerName)}: ${formatMoney(Number(d.amount) - Number(d.paidAmount), d.currency)}`
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

  // Har kuni soat 09:00 da — AI To'lov kuni eslatmasi va Yuk olish sikli eslatmasi (har bir faol egaga alohida)
  cron.schedule(
    '0 9 * * *',
    async () => {
      logger.info('Running cron: 09:00 Smart Payment Day & Restock Reminders');
      try {
        await runDailySmartReminders(bot);
      } catch (error) {
        logger.error({ error }, 'Failed to run 09:00 smart payment & restock reminders cron');
      }
    },
    opts
  );

  // Har kuni soat 20:00 da — Kassa yopilmagan bo'lsa eslatma (Toshkent UTC+5 dateKey)
  cron.schedule(
    '0 20 * * *',
    async () => {
      logger.info('Running cron: 20:00 Z-Report Reminder');
      try {
        const users = await getActiveStoreUsers();
        const { dateKey } = getTashkentDayRange();
        for (const u of users) {
          const register = await prisma.dailyRegister.findUnique({
            where: { ownerId_date: { ownerId: u.telegramId, date: dateKey } },
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

  // Har kuni soat 21:00 da — Kunlik yakuniy hisobot (Toshkent UTC+5 dateKey, har bir foydalanuvchi uchun alohida)
  cron.schedule(
    '0 21 * * *',
    async () => {
      logger.info('Running cron: 21:00 Daily Summary');
      try {
        const users = await getActiveStoreUsers();
        const { dateKey } = getTashkentDayRange();
        for (const u of users) {
          const [r, supAgg, todayAuto] = await Promise.all([
            prisma.dailyRegister.findUnique({
              where: { ownerId_date: { ownerId: u.telegramId, date: dateKey } },
            }),
            prisma.supplier.aggregate({
              where: { ownerId: u.telegramId, isActive: true },
              _sum: { debtUzs: true, debtUsd: true },
            }),
            ReportService.getTodayZReportAutoMetrics(u.telegramId),
          ]);
          const cashBreakdownLines = [
            `📦 Naqd tovar xaridlari [Kassadan]: ${formatMoney(todayAuto.dailyCashPurchasesUzs, 'UZS')}`,
            ...(todayAuto.safeCashPurchasesUzs > 0
              ? [
                  `🔐 Naqd tovar xaridlari [Seyfdan]: ${formatMoney(todayAuto.safeCashPurchasesUzs, 'UZS')} _(bugungi kassadan ayirilmadi)_`,
                ]
              : []),
          ].join('\n');
          const body = r
            ? `Naqd (UZS): ${formatMoney(r.cashUzs, 'UZS')}\nClick: ${formatMoney(r.clickAmount, 'UZS')}\nTerminal: ${formatMoney(r.terminalAmount, 'UZS')}\n${cashBreakdownLines}\nJami Savdo: ${formatMoney(r.totalDailySalesUzs || r.cashUzs, 'UZS')}\nKassa Yopilgan: ${r.isClosed ? 'HA' : "YO'Q"}\n\n📊 JAMI QARZ (UZS): ${formatMoney(supAgg._sum.debtUzs || 0, 'UZS')}\n💵 JAMI QARZ (USD/USDT): ${formatMoney(supAgg._sum.debtUsd || 0, 'USD')}\n`
            : `Bugun kassa ma'lumotlari kiritilmadi!\n${cashBreakdownLines}\n\n📊 JAMI QARZ (UZS): ${formatMoney(supAgg._sum.debtUzs || 0, 'UZS')}\n💵 JAMI QARZ (USD/USDT): ${formatMoney(supAgg._sum.debtUsd || 0, 'USD')}\n`;
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
