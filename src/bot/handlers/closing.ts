import { Composer } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatSom, getTashkentDayRange, parseSmartAmount } from '../../utils/formatters';
import { getConfirmationKeyboard } from '../keyboards/inline';
import { clearSession } from '../../utils/telegram';
import { isMenuButton } from '../keyboards/menu';
import { ReportService } from '../../services/report.service';

export const closingHandler = new Composer<MyContext>();

closingHandler.hears('📊 Z-Hisobot (Kunlik)', async (ctx) => {
  if (!ctx.from) return;
  clearSession(ctx);
  const ownerId = String(ctx.from.id);
  const { dateKey } = getTashkentDayRange();
  const existing = await prisma.dailyRegister.findUnique({
    where: { ownerId_date: { ownerId, date: dateKey } },
  });
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
  if (!ctx.session.step?.startsWith('Z_REPORT_') || !ctx.from) return next();
  const ownerId = String(ctx.from.id);
  const rawText = ctx.message.text.trim();
  if (rawText.startsWith('/') || isMenuButton(rawText)) {
    clearSession(ctx);
    return next();
  }

  const amount = rawText === '0' ? 0 : parseSmartAmount(rawText);
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

    const auto = await ReportService.getTodayZReportAutoMetrics(ownerId);
    const totalDailySalesUzs =
      Number(d.terminalAmount || 0) +
      Number(d.clickAmount || 0) +
      Number(d.cashRemainingInDrawer || 0) +
      auto.dailyCashPurchasesUzs +
      auto.dailySupplierPaymentsUzs;

    const actionId = `zrep_${Date.now()}`;
    ctx.session.step = actionId;

    const lines = [
      `📊 **KUNLIK Z-OTCHYOT TASDIQLASH**`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `💳 Terminalda savdo: ${formatSom(d.terminalAmount)}`,
      `📱 Click / Karta savdo: ${formatSom(d.clickAmount)}`,
      `💵 Kassada qolgan naqd pul: ${formatSom(d.cashRemainingInDrawer)}`,
      `📦 Bugungi kassadan naqdga olingan tovarlar: ${formatSom(auto.dailyCashPurchasesUzs)} (${auto.dailyCashPurchasesCount} ta nakladnoy)`,
      `🤝 Bugungi kassadan ta'minotchilarga berilgan pul: ${formatSom(auto.dailySupplierPaymentsUzs)} (${auto.dailySupplierPaymentsCount} ta to'lov)`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `💰 **KUN DAVOMIDA JAMI SAVDO: ${formatSom(totalDailySalesUzs)}**`,
    ];

    if (auto.previousSafePaymentsUzs > 0) {
      lines.push(
        `_(ℹ️ Ma'lumot uchun: Kechagi puldan/seyfdan ta'minotchilarga berilgan ${formatSom(auto.previousSafePaymentsUzs)} kecha hisoblangani sababli bugungi savdoga qayta qo'shilmadi)_`
      );
    }

    lines.push(``, `Kassani yopaymi?`);

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: getConfirmationKeyboard(actionId),
    });
  }
});

closingHandler.callbackQuery(/^confirm_zrep_/, async (ctx) => {
  const d = ctx.session.tempData;
  if (!d || !ctx.from) return ctx.answerCallbackQuery({ text: "Eskirgan so'rov!", show_alert: true });
  const ownerId = String(ctx.from.id);
  try {
    const zReport = await ReportService.generateAndSaveZReport({
      ownerId,
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
