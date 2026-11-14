import { Composer } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatSom, getTashkentDayRange, parseCurrencyAndAmount } from '../../utils/formatters';
import { getConfirmationKeyboard } from '../keyboards/inline';
import { clearSession } from '../../utils/telegram';
import { ReportService } from '../../services/report.service';

export const closingHandler = new Composer<MyContext>();

closingHandler.hears('📊 Z-Hisobot (Kunlik)', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;
  const { dateKey } = getTashkentDayRange();
  const existing = await prisma.dailyRegister.findUnique({ where: { date: dateKey } });
  if (existing?.isClosed) {
    return ctx.reply(
      `✅ Bugungi kassa allaqachon yopilgan.\n💰 Bugungi jami savdo: **${formatSom(existing.totalDailySalesUzs || existing.cashUzs)}**`,
      { parse_mode: 'Markdown' }
    );
  }
  ctx.session.step = 'Z_REPORT_TERMINAL';
  ctx.session.tempData = {};
  await ctx.reply("1️⃣ 💳 Bugungi **Terminal** savdosi summasini kiriting (yo'q bo'lsa `0` yozing):", {
    parse_mode: 'Markdown',
  });
});

closingHandler.on('message:text', async (ctx, next) => {
  if (!ctx.session.step?.startsWith('Z_REPORT_')) return next();
  const rawText = ctx.message.text.trim();
  if (rawText.startsWith('/')) return next();

  const parsed = parseCurrencyAndAmount(rawText);
  const amount = rawText === '0' ? 0 : parsed.amount;
  if (isNaN(amount) || amount < 0) return ctx.reply('❌ Iltimos, faqat musbat raqam (yoki 0) kiriting!');

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

    const { startOfDay, endOfDay } = getTashkentDayRange();
    const [cashInvoices, supplierPayments] = await Promise.all([
      prisma.invoice.findMany({
        where: { createdAt: { gte: startOfDay, lte: endOfDay }, currency: 'UZS', paidCashAmount: { gt: 0 } },
        select: { paidCashAmount: true },
      }),
      prisma.supplierPayment.findMany({
        where: { createdAt: { gte: startOfDay, lte: endOfDay }, currency: 'UZS' },
        select: { amount: true },
      }),
    ]);

    const dailyCashPurchasesUzs = cashInvoices.reduce((s, i) => s + Number(i.paidCashAmount || 0), 0);
    const dailySupplierPaymentsUzs = supplierPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalDailySalesUzs =
      Number(d.terminalAmount || 0) +
      Number(d.clickAmount || 0) +
      Number(d.cashRemainingInDrawer || 0) +
      dailyCashPurchasesUzs +
      dailySupplierPaymentsUzs;

    const actionId = `zrep_${Date.now()}`;
    ctx.session.step = actionId;

    const previewText = [
      `🧾 **KUNLIK Z-OTCHYOT TASDIQLASH**`,
      ``,
      `1️⃣ 💳 Terminal: ${formatSom(d.terminalAmount)}`,
      `2️⃣ 📱 Click / O'tkazma: ${formatSom(d.clickAmount)}`,
      `3️⃣ 💵 Kassadagi qoldiq naqd pul: ${formatSom(d.cashRemainingInDrawer)}`,
      `4️⃣ 📦 Bugun naqdga olingan yuklar (avtomat): +${formatSom(dailyCashPurchasesUzs)} (${cashInvoices.length} ta nakladnoy)`,
      `5️⃣ 🤝 Bugun ta'minotchilarga berilgan pul (avtomat): +${formatSom(dailySupplierPaymentsUzs)} (${supplierPayments.length} ta to'lov)`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💰 **BUGUNGI JAMI SAVDO (1+2+3+4+5): ${formatSom(totalDailySalesUzs)}**`,
      ``,
      `Kassani yopaymi?`,
    ].join('\n');

    await ctx.reply(previewText, {
      parse_mode: 'Markdown',
      reply_markup: getConfirmationKeyboard(actionId),
    });
  }
});

closingHandler.callbackQuery(/^confirm_zrep_/, async (ctx) => {
  const d = ctx.session.tempData;
  if (!d) return ctx.answerCallbackQuery({ text: "Eskirgan so'rov!", show_alert: true });
  try {
    const zReport = await ReportService.generateAndSaveZReport({
      terminalAmount: Number(d.terminalAmount || 0),
      clickAmount: Number(d.clickAmount || 0),
      cashRemainingInDrawer: Number(d.cashRemainingInDrawer ?? d.cashUzs ?? 0),
    });
    await ctx.editMessageText(zReport.formattedText);
  } catch {
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi.', show_alert: true });
  } finally {
    clearSession(ctx);
  }
});

closingHandler.callbackQuery(/^cancel_zrep_/, async (ctx) => {
  clearSession(ctx);
  await ctx.editMessageText('❌ Z-Hisobot bekor qilindi.');
});
