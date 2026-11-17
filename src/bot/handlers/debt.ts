import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import {
  formatCurrency,
  formatDate,
  formatSupplierDebtLine,
  formatTotalDebtBlock,
  parseCurrencyAndAmount,
} from '../../utils/formatters';
import { addPaginationRow, addTwoColButtons, getTemplateConfirmKeyboard } from '../keyboards/inline';
import { replyOrEdit, clearSession, registerTemplateActions } from '../../utils/telegram';
import { toLatinUz } from '../../utils/transliterate';

export const debtHandler = new Composer<MyContext>();
const PER_PAGE = 10;

async function applyCustomerPaymentFIFO(
  ownerId: string,
  customerName: string,
  payAmount: number,
  currency: 'UZS' | 'USD' = 'UZS'
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const activeDebts = await tx.customerDebt.findMany({
      where: { ownerId, customerName, currency, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, amount: true, paidAmount: true },
    });
    let unapplied = Number(payAmount.toFixed(2));
    for (const d of activeDebts) {
      if (unapplied <= 0) break;
      const rem = Number((Number(d.amount) - Number(d.paidAmount)).toFixed(2));
      if (rem <= 0) continue;
      if (unapplied >= rem) {
        await tx.customerDebt.update({
          where: { id: d.id },
          data: { paidAmount: d.amount, status: 'PAID' },
        });
        unapplied = Number((unapplied - rem).toFixed(2));
      } else {
        await tx.customerDebt.update({
          where: { id: d.id },
          data: { paidAmount: Number((Number(d.paidAmount) + unapplied).toFixed(2)), status: 'PARTIALLY_PAID' },
        });
        unapplied = 0;
      }
    }
    const remDebts = await tx.customerDebt.findMany({
      where: { ownerId, customerName, currency, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      select: { amount: true, paidAmount: true },
    });
    return remDebts.reduce(
      (acc, d) => Number((acc + (Number(d.amount) - Number(d.paidAmount))).toFixed(2)),
      0
    );
  });
}

async function sendDebtorsPage(ctx: MyContext, page: number, isEdit = false) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const debts = await prisma.customerDebt.findMany({
    where: { ownerId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, customerName: true, amount: true, paidAmount: true, currency: true },
  });
  const kb = new InlineKeyboard();
  if (!debts.length)
    return replyOrEdit(ctx, 'Nasiyalar mavjud emas.', kb.text("➕ Nasiya qo'shish", 'debt:new'), isEdit);

  let totalUzs = 0;
  let totalUsd = 0;
  const grouped: Record<string, { sumUzs: number; sumUsd: number; firstId: string }> = {};
  for (const d of debts) {
    const rem = Number((Number(d.amount) - Number(d.paidAmount)).toFixed(2));
    if (rem > 0) {
      grouped[d.customerName] ??= { sumUzs: 0, sumUsd: 0, firstId: d.id };
      if (d.currency === 'USD') {
        grouped[d.customerName].sumUsd = Number((grouped[d.customerName].sumUsd + rem).toFixed(2));
        totalUsd = Number((totalUsd + rem).toFixed(2));
      } else {
        grouped[d.customerName].sumUzs = Number((grouped[d.customerName].sumUzs + rem).toFixed(2));
        totalUzs = Number((totalUzs + rem).toFixed(2));
      }
    }
  }

  const groupedArray = Object.entries(grouped).sort(
    (a, b) => b[1].sumUzs - a[1].sumUzs || b[1].sumUsd - a[1].sumUsd
  );
  const totalPages = Math.ceil(groupedArray.length / PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const pageItems = groupedArray.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const lines = pageItems
    .map(([name, data]) => formatSupplierDebtLine(name, data.sumUzs, data.sumUsd, '👤 '))
    .join('\n');
  const text =
    `👥 **Nasiyadorlar (Sahifa ${currentPage}/${totalPages})**\n\n` +
    `${lines}\n\n` +
    `${formatTotalDebtBlock(totalUzs, totalUsd)}`;

  addTwoColButtons(
    kb,
    pageItems,
    ([n]) => n,
    ([, d]) => d.sumUzs || d.sumUsd,
    ([, d]) => `debt:v:${d.firstId}`
  );
  addPaginationRow(kb, currentPage, totalPages, 'debt:p:');
  kb.text('➕ Yangi', 'debt:new').text('🔙 Asosiy', 'menu:main');
  await replyOrEdit(ctx, text, kb, isEdit);
}

debtHandler.hears('👥 Nasiyadorlar', async (ctx) => {
  await sendDebtorsPage(ctx, 1);
});
debtHandler.callbackQuery(/^debt:p:(\d+)$/, (ctx) =>
  sendDebtorsPage(ctx, parseInt(ctx.match[1], 10), true)
);
debtHandler.callbackQuery('debt:back', (ctx) => sendDebtorsPage(ctx, 1, true));

debtHandler.callbackQuery(/^debt:v:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const firstId = ctx.match[1];
  const firstDebt = await prisma.customerDebt.findFirst({
    where: { id: firstId, ownerId },
    select: { id: true, customerName: true },
  });
  if (!firstDebt) return ctx.answerCallbackQuery('Topilmadi');

  const name = firstDebt.customerName;
  const debts = await prisma.customerDebt.findMany({
    where: { ownerId, customerName: name, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    orderBy: { createdAt: 'desc' },
    select: { amount: true, paidAmount: true, currency: true, createdAt: true, itemsSummary: true },
  });

  let totalUzs = 0;
  let totalUsd = 0;
  const lines = debts
    .map((d) => {
      const rem = Number((Number(d.amount) - Number(d.paidAmount)).toFixed(2));
      if (d.currency === 'USD') totalUsd = Number((totalUsd + rem).toFixed(2));
      else totalUzs = Number((totalUzs + rem).toFixed(2));
      return `🔹 ${formatDate(d.createdAt)} | **${formatCurrency(rem, d.currency)}**${d.itemsSummary ? `\n   📝 ${d.itemsSummary}` : ''}`;
    })
    .join('\n');

  const shareText = `Hurmatli ${name}, do'konimiz hisobida sizning qolgan nasiya summangiz: ${formatCurrency(totalUzs, 'UZS')}${totalUsd > 0 ? ` va ${formatCurrency(totalUsd, 'USD')}` : ''}. Rahmat!`;
  const kb = new InlineKeyboard()
    .switchInlineCurrent("➕ Yangi qarz qo'shish", `Operatsiya: Nasiya\nMijoz: ${name}\nSumma: \nTelefon: \nIzoh: `)
    .row()
    .text("💸 Qarz to'lash (Yopish)", `debt:pay:${firstId}`)
    .row()
    .url('📤 Mijozga eslatma yuborish', `https://t.me/share/url?url=${encodeURIComponent(shareText)}`)
    .row()
    .text('🔙 Orqaga', 'debt:back');

  await replyOrEdit(
    ctx,
    `👤 **Mijoz:** ${name}\n\n${lines}\n\n${formatTotalDebtBlock(totalUzs, totalUsd)}`,
    kb,
    true
  );
});

debtHandler.callbackQuery(/^debt:pay:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const firstId = ctx.match[1];
  const firstDebt = await prisma.customerDebt.findFirst({
    where: { id: firstId, ownerId },
    select: { customerName: true, currency: true },
  });
  if (!firstDebt) return ctx.answerCallbackQuery('Mijoz topilmadi.');

  const agg = await prisma.customerDebt.aggregate({
    where: { ownerId, customerName: firstDebt.customerName, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    _sum: { amount: true, paidAmount: true },
  });
  const totalRem = Number((Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0)).toFixed(2));

  ctx.session.step = 'DEBT_PAYMENT';
  ctx.session.tempData = { customerName: firstDebt.customerName, firstId, totalRem };

  const kb =
    totalRem > 0
      ? new InlineKeyboard()
          .text(
            `💯 To'liq yopish (${formatCurrency(totalRem, firstDebt.currency)})`,
            `debt:qpay:${firstId}:${totalRem}`
          )
          .row()
          .text(
            `🌓 Yarmini yopish (${formatCurrency(Number((totalRem / 2).toFixed(2)), firstDebt.currency)})`,
            `debt:qpay:${firstId}:${Number((totalRem / 2).toFixed(2))}`
          )
      : undefined;

  await ctx.reply(
    `💸 **${firstDebt.customerName}** tomonidan to'langan summani raqamda kiriting:\n(Masalan: 50000, 50 ming yoki $25.50)`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

debtHandler.callbackQuery(/^debt:qpay:(.+):([\d.]+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const [, firstId, rawAmt] = ctx.match;
  const payAmount = Number(rawAmt);
  const firstDebt = await prisma.customerDebt.findFirst({
    where: { id: firstId, ownerId },
    select: { customerName: true, currency: true },
  });
  if (!firstDebt || !payAmount) return ctx.answerCallbackQuery('Topilmadi');

  const customerName = firstDebt.customerName;
  const remainingTotal = await applyCustomerPaymentFIFO(ownerId, customerName, payAmount, firstDebt.currency);
  clearSession(ctx);

  const suffix =
    remainingTotal > 0
      ? `💰 **Qolgan nasiya summasi:** ${formatCurrency(remainingTotal, firstDebt.currency)}`
      : `🎉 **${customerName} barcha qarzlarini to'liq yopdi!**`;
  await ctx.editMessageText(
    `✅ **${customerName}** tomonidan **${formatCurrency(payAmount, firstDebt.currency)}** to'lov qabul qilindi!\n\n${suffix}`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text("👥 Nasiyadorlar ro'yxatiga qaytish", 'debt:back'),
    }
  );
});

debtHandler.callbackQuery('debt:new', async (ctx) => {
  ctx.session.step = 'ADD_DEBT_TEMPLATE';
  await ctx.reply(
    `👇 **"Shablonni to'ldirish"** tugmasini bosing yoki shunchaki oddiy matnda yozing (masalan: \`Alisher 120000 non va yog'\`)!`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().switchInlineCurrent(
        "✍️ Shablonni to'ldirish",
        `Operatsiya: Nasiya\nMijoz: \nSumma: \nTelefon: \nIzoh: `
      ),
    }
  );
});

debtHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step === 'DEBT_PAYMENT' && ctx.from) {
    const ownerId = String(ctx.from.id);
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return next();
    const { amount: payAmount, currency } = parseCurrencyAndAmount(rawText);
    if (!payAmount || payAmount <= 0 || isNaN(payAmount)) {
      return ctx.reply(
        "❌ To'g'ri to'lov summasini kiriting (masalan: 50000, 50 ming yoki $25.50). To'xtatish uchun /start."
      );
    }

    const { customerName } = ctx.session.tempData;
    const remainingTotal = await applyCustomerPaymentFIFO(ownerId, customerName, payAmount, currency);
    clearSession(ctx);
    const suffix =
      remainingTotal > 0
        ? `💰 **Qolgan nasiya summasi:** ${formatCurrency(remainingTotal, currency)}`
        : `🎉 **${customerName} barcha qarzlarini to'liq yopdi!**`;
    return ctx.reply(
      `✅ **${customerName}** tomonidan **${formatCurrency(payAmount, currency)}** to'lov qabul qilindi!\n\n${suffix}`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text("👥 Nasiyadorlar ro'yxatiga qaytish", 'debt:back'),
      }
    );
  }

  if (ctx.session.step !== 'ADD_DEBT_TEMPLATE') return next();
  const text = ctx.message.text;
  if (!text.includes('Operatsiya: Nasiya') && !text.includes('Mijoz:')) {
    ctx.session.step = undefined;
    return next();
  }

  const customerName = text.match(/Mijoz:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const rawSummaLine = text.match(/Summa:\s*([^\n]+)/i)?.[1] || '';
  const { amount, currency } = parseCurrencyAndAmount(rawSummaLine);
  const phone = text.match(/Telefon:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const note = text.match(/Izoh:\s*([\s\S]+)/i)?.[1]?.trim() || '';

  if (!customerName) return ctx.reply("❌ Mijoz ismini aniqlab bo'lmadi.");
  if (!amount) return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");

  const actionId = `debt_conf_${Date.now()}`;
  ctx.session.tempData = { type: 'DEBT_TEMPLATE', data: { amount, currency, customerName, phone, note } };
  ctx.session.step = actionId;

  const confirmText = `🧾 *Nasiya Tahlili:*\n▫️ *Operatsiya:* Nasiya savdo\n▫️ *Mijoz:* ${customerName}\n▫️ *Summa:* ${formatCurrency(amount, currency)}\n${phone ? `▫️ *Telefon:* ${phone}\n` : ''}${note ? `▫️ *Izoh:* ${note}\n` : ''}\nMa'lumotlar to'g'rimi?`;
  await ctx.reply(confirmText, {
    parse_mode: 'Markdown',
    reply_markup: getTemplateConfirmKeyboard('debt:edit', actionId),
  });
});

registerTemplateActions(
  debtHandler,
  'debt',
  'ADD_DEBT_TEMPLATE',
  'DEBT_TEMPLATE',
  async (ctx, { amount, currency = 'UZS', customerName, phone, note }) => {
    const ownerId = String(ctx.from?.id || '');
    const cleanCust = toLatinUz(customerName);
    await prisma.customerDebt.create({
      data: { ownerId, customerName: cleanCust, amount, currency, phone: phone || null, itemsSummary: note ? toLatinUz(note) : null },
    });
    const agg = await prisma.customerDebt.aggregate({
      where: { ownerId, customerName: cleanCust, currency },
      _sum: { amount: true, paidAmount: true },
    });
    const totalRemaining = Number((Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0)).toFixed(2));
    return `✅ Nasiya saqlandi: ${cleanCust} (+${formatCurrency(amount, currency)})\n💰 Yangilangan umumiy qarz: ${formatCurrency(totalRemaining, currency)}${note ? `\n📝 Izoh: ${toLatinUz(note)}` : ''}`;
  }
);
