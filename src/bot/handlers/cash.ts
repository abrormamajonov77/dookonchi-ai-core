import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import {
  formatCurrency,
  formatMoney,
  formatDate,
  getTashkentDayRange,
  parseCurrencyAndAmount,
  parseSmartAmount,
} from '../../utils/formatters';
import { getCashSourceSelectionKeyboard } from '../keyboards/inline';
import { clearSession, safeEditMessageText, safeReply, sanitizeMdV1 } from '../../utils/telegram';
import { toLatinUz } from '../../utils/transliterate';
import {
  CASH_SOURCE_PROMPT_TEXT,
  CashSourceValue,
  cashSourceToPaymentSource,
  formatCashSourceBadge,
  formatCashSourceDisplay,
  formatCashSourceZReportNote,
  isSafeCashSource,
} from '../../utils/cash-source';

export const cashHandler = new Composer<MyContext>();

cashHandler.hears('💵 Naqd', async (ctx) => {
  if (!ctx.from) return;
  clearSession(ctx);
  const ownerId = String(ctx.from.id);
  const now = new Date();
  const { startOfDay, endOfDay } = getTashkentDayRange(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 5 * 60 * 60 * 1000);

  const [recentTx, monthStats, todayTxs] = await Promise.all([
    prisma.cashTransaction.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.cashTransaction.aggregate({
      where: { ownerId, createdAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.cashTransaction.findMany({
      where: { ownerId, createdAt: { gte: startOfDay, lte: endOfDay }, currency: 'UZS' },
      select: { amount: true, cashSource: true, paymentSource: true },
    }),
  ]);

  let todayRegisterSum = 0;
  let todaySafeSum = 0;
  for (const tx of todayTxs) {
    const amt = Math.abs(Number(tx.amount || 0));
    if (isSafeCashSource(tx)) todaySafeSum += amt;
    else todayRegisterSum += amt;
  }
  const todayTotal = todayRegisterSum + todaySafeSum;

  const txLines = recentTx.length
    ? `📝 **Oxirgi 10 ta amaliyot:**\n` +
      recentTx
        .map((tx) => {
          const badge = formatCashSourceBadge(tx.cashSource, tx.paymentSource);
          const badgeIcon = badge === 'Seyfdan' ? '🔐' : '💵';
          return `🔹 ${formatDate(tx.createdAt)} | **${sanitizeMdV1(tx.partyName)}** - ${formatCurrency(tx.amount, tx.currency)} [${badgeIcon} ${badge}]${tx.items ? `\n   ✏️ ${sanitizeMdV1(tx.items).slice(0, 80)}` : ''}`;
        })
        .join('\n')
    : "Amaliyotlar yo'q.";

  const todayBreakdown =
    `📊 **Bugungi jami naqd xaridlar:** ${formatMoney(todayTotal)}\n` +
    `   💵 Bugungi kassadan: ${formatMoney(todayRegisterSum)}\n` +
    `   🔐 Seyfdan (kechagi pul): ${formatMoney(todaySafeSum)}`;

  await safeReply(
    ctx,
    `💵 **Naqd Savdo va Xaridlar Arxiv:**\n\n${todayBreakdown}\n📊 **Shu oydagi aylanma:** ${formatMoney(monthStats._sum.amount || 0)}\n\n${txLines}`,
    { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('➕ Yangi naqd xarid', 'cash:new') }
  );
});

cashHandler.callbackQuery('cash:new', async (ctx) => {
  ctx.session.step = 'ADD_CASH_TEMPLATE';
  await ctx.reply(
    `👇 **"Shablonni to'ldirish"** tugmasini bosing!\nShunda shablon matni avtomatik ravishda yozish maydoningizga tushadi va siz faqat kerakli joylarini to'ldirib yuborasiz.\n\n💡 *Eslatma:* Siz oddiy matn orqali (masalan: "Naqdga 200 ming shakar oldik") yozsangiz ham bot buni to'g'ri tushunadi.`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().switchInlineCurrent(
        "✍️ Shablonni to'ldirish",
        `Operatsiya: Naqd xarid\nKimdan/Brend: \nSumma: \nTovar/Izoh: `
      ),
    }
  );
});

cashHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'ADD_CASH_TEMPLATE') return next();
  const text = ctx.message.text;
  if (!text.includes('Operatsiya: Naqd xarid')) {
    ctx.session.step = undefined;
    return next();
  }

  const partyName = toLatinUz(text.match(/Kimdan\/Brend:\s*([^\n]+)/i)?.[1]?.trim() || '');
  const rawSummaLine = text.match(/Summa:\s*([^\n]+)/i)?.[1] || '';
  const parsedMoney = parseCurrencyAndAmount(rawSummaLine);
  const amount = parseSmartAmount(rawSummaLine) || parsedMoney.amount;
  const currency = parsedMoney.currency;
  const items = toLatinUz(text.match(/Tovar\/Izoh:\s*([\s\S]+)/i)?.[1]?.trim() || '');
  if (!amount || amount <= 0) return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");

  const actionId = `cash_${Date.now()}`;
  ctx.session.tempData = {
    type: 'CASH_TEMPLATE',
    actionId,
    data: { amount, currency, partyName, items },
  };
  ctx.session.step = actionId;

  const confirmText =
    `🧾 *Naqd Xarid Tahlili:*\n` +
    `▫️ *Operatsiya:* Naqd tovar xaridi\n` +
    `▫️ *Kimdan:* ${sanitizeMdV1(partyName || "Noma'lum")}\n` +
    `▫️ *Summa:* ${formatCurrency(amount, currency)}\n` +
    `${items ? `▫️ *Tovar/Izoh:* ${sanitizeMdV1(items)}\n` : ''}` +
    `\n*(Bu operatsiya qarzlar balansiga ta'sir qilmaydi)*\n\n` +
    `${CASH_SOURCE_PROMPT_TEXT}`;

  await safeReply(ctx, confirmText, {
    parse_mode: 'Markdown',
    reply_markup: getCashSourceSelectionKeyboard(actionId, 'cash:edit'),
  });
});

cashHandler.callbackQuery('cash:edit', async (ctx) => {
  ctx.session.step = 'ADD_CASH_TEMPLATE';
  await ctx.editMessageText("✍️ To'g'ri ma'lumotlarni qaytadan yozib yuboring (oddiy matnda yoki shablonda):");
});

// Safety guard if any legacy confirm_cash_conf_ button is tapped: always enforce cash source selection
cashHandler.callbackQuery(/^confirm_cash_conf_/, async (ctx) => {
  if (ctx.session.tempData?.type !== 'CASH_TEMPLATE' || !ctx.session.tempData?.data) {
    return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
  }
  const actionId = ctx.session.tempData.actionId || `cash_${Date.now()}`;
  ctx.session.tempData.actionId = actionId;
  ctx.session.step = actionId;
  const { amount, currency = 'UZS', partyName, items } = ctx.session.tempData.data;
  const promptText =
    `🧾 *Naqd Xarid Tahlili:*\n` +
    `▫️ *Kimdan:* ${sanitizeMdV1(partyName || "Noma'lum")}\n` +
    `▫️ *Summa:* ${formatCurrency(amount, currency)}\n` +
    `${items ? `▫️ *Tovar/Izoh:* ${sanitizeMdV1(items)}\n` : ''}` +
    `\n${CASH_SOURCE_PROMPT_TEXT}`;
  if (ctx.callbackQuery.message && ctx.chat?.id) {
    await safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, promptText, {
      parse_mode: 'Markdown',
      reply_markup: getCashSourceSelectionKeyboard(actionId, 'cash:edit'),
    });
  }
});

// Mandatory cash source selection callback for manual "💵 Naqd" purchases
cashHandler.callbackQuery(/^cs:(T|S):(cash_.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const cashSource: CashSourceValue = ctx.match[1] === 'S' ? 'SAFE' : 'TODAY_REGISTER';
  const actionId = ctx.match[2];

  if (
    ctx.session.tempData?.type !== 'CASH_TEMPLATE' ||
    !ctx.session.tempData?.data ||
    (ctx.session.tempData.actionId && ctx.session.tempData.actionId !== actionId)
  ) {
    return ctx.answerCallbackQuery({ text: "Bu so'rov eskirgan, qaytadan kiriting!", show_alert: true });
  }

  const ownerId = String(ctx.from.id);
  const { amount, currency = 'UZS', partyName, items } = ctx.session.tempData.data;
  const paymentSource = cashSourceToPaymentSource(cashSource);
  const cleanParty = toLatinUz(partyName || "Noma'lum").trim() || "Noma'lum";
  const cleanItems = items ? toLatinUz(String(items)).trim() : null;

  try {
    await prisma.cashTransaction.create({
      data: {
        ownerId,
        partyName: cleanParty,
        amount,
        currency,
        paymentSource,
        cashSource,
        items: cleanItems,
        createdBy: ownerId,
      },
    });

    const sourceDisplay = formatCashSourceDisplay(cashSource);
    const sourceBadge = formatCashSourceBadge(cashSource);
    const zNote = formatCashSourceZReportNote(cashSource);
    const msg =
      `✅ **Naqd xarid (${sourceBadge}) muvaffaqiyatli saqlandi!**\n\n` +
      `🏢 Kimdan: **${sanitizeMdV1(cleanParty)}**\n` +
      `💵 Summa: **${formatCurrency(amount, currency)}**\n` +
      `${cleanItems ? `📝 Izoh: ${sanitizeMdV1(cleanItems)}\n` : ''}` +
      `🗂 Pul manbasi: **${sourceDisplay}**\n` +
      `📊 Qarzga ta'sir qilmadi. ${zNote}`;

    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, msg, {
        parse_mode: 'Markdown',
      });
    }
    clearSession(ctx);
  } catch {
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi, qayta urinib ko'ring.", show_alert: true });
  }
});

cashHandler.callbackQuery(/^cancel_cash_/, async (ctx) => {
  clearSession(ctx);
  await ctx.editMessageText('❌ Bekor qilindi.');
});
