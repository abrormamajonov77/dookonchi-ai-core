import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney, formatDate, parseAmount } from '../../utils/formatters';
import { addPaginationRow, addTwoColButtons, getTemplateConfirmKeyboard } from '../keyboards/inline';
import { replyOrEdit, clearSession, registerTemplateActions } from '../../utils/telegram';

export const debtHandler = new Composer<MyContext>();
const PER_PAGE = 10;

async function applyCustomerPaymentFIFO(customerName: string, payAmount: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const activeDebts = await tx.customerDebt.findMany({
      where: { customerName, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, amount: true, paidAmount: true }
    });
    let unapplied = payAmount;
    for (const d of activeDebts) {
      if (unapplied <= 0) break;
      const rem = Number(d.amount) - Number(d.paidAmount);
      if (rem <= 0) continue;
      if (unapplied >= rem) {
        await tx.customerDebt.update({ where: { id: d.id }, data: { paidAmount: d.amount, status: 'PAID' } });
        unapplied -= rem;
      } else {
        await tx.customerDebt.update({ where: { id: d.id }, data: { paidAmount: { increment: unapplied }, status: 'PARTIALLY_PAID' } });
        unapplied = 0;
      }
    }
    const remDebts = await tx.customerDebt.findMany({
      where: { customerName, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      select: { amount: true, paidAmount: true }
    });
    return remDebts.reduce((acc, d) => acc + (Number(d.amount) - Number(d.paidAmount)), 0);
  });
}

async function sendDebtorsPage(ctx: MyContext, page: number, isEdit = false) {
  const debts = await prisma.customerDebt.findMany({
    where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, customerName: true, amount: true, paidAmount: true }
  });
  const kb = new InlineKeyboard();
  if (!debts.length) return replyOrEdit(ctx, 'Nasiyalar mavjud emas.', kb.text("➕ Nasiya qo'shish", 'debt:new'), isEdit);

  let total = 0;
  const grouped: Record<string, { sum: number; firstId: string }> = {};
  for (const d of debts) {
    const rem = Number(d.amount) - Number(d.paidAmount);
    if (rem > 0) {
      grouped[d.customerName] ??= { sum: 0, firstId: d.id };
      grouped[d.customerName].sum += rem;
      total += rem;
    }
  }

  const groupedArray = Object.entries(grouped).sort((a, b) => b[1].sum - a[1].sum);
  const totalPages = Math.ceil(groupedArray.length / PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const pageItems = groupedArray.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const lines = pageItems.map(([name, data], idx) => `${(currentPage - 1) * PER_PAGE + idx + 1}. **${name}**: ${formatMoney(data.sum)}`).join('\n');
  const text = `👥 **Nasiyadorlar (Sahifa ${currentPage}/${totalPages})**\nJami nasiya: ${formatMoney(total)}\n\n${lines}\n`;

  addTwoColButtons(kb, pageItems, ([n]) => n, ([, d]) => d.sum, ([, d]) => `debt:v:${d.firstId}`);
  addPaginationRow(kb, currentPage, totalPages, 'debt:p:');
  kb.text('➕ Yangi', 'debt:new').text('🔙 Asosiy', 'menu:main');
  await replyOrEdit(ctx, text, kb, isEdit);
}

debtHandler.hears('👥 Nasiyadorlar', async (ctx) => { if (ctx.user?.role === 'OWNER') await sendDebtorsPage(ctx, 1); });
debtHandler.callbackQuery(/^debt:p:(\d+)$/, (ctx) => sendDebtorsPage(ctx, parseInt(ctx.match[1], 10), true));
debtHandler.callbackQuery('debt:back', (ctx) => sendDebtorsPage(ctx, 1, true));

debtHandler.callbackQuery(/^debt:v:(.+)$/, async (ctx) => {
  const firstId = ctx.match[1];
  const firstDebt = await prisma.customerDebt.findUnique({ where: { id: firstId }, select: { id: true, customerName: true } });
  if (!firstDebt) return ctx.answerCallbackQuery('Topilmadi');

  const name = firstDebt.customerName;
  const debts = await prisma.customerDebt.findMany({
    where: { customerName: name, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    orderBy: { createdAt: 'desc' },
    select: { amount: true, paidAmount: true, currency: true, createdAt: true, itemsSummary: true }
  });

  let total = 0;
  const lines = debts.map(d => {
    const rem = Number(d.amount) - Number(d.paidAmount);
    total += rem;
    return `🔹 ${formatDate(d.createdAt)} | **${formatMoney(rem, d.currency)}**${d.itemsSummary ? `\n   📝 ${d.itemsSummary}` : ''}`;
  }).join('\n');

  const shareText = `Hurmatli ${name}, do'konimiz hisobida sizning qolgan nasiya summangiz: ${formatMoney(total)}. Rahmat!`;
  const kb = new InlineKeyboard()
    .switchInlineCurrent("➕ Yangi qarz qo'shish", `Operatsiya: Nasiya\nMijoz: ${name}\nSumma: \nTelefon: \nIzoh: `).row()
    .text("💸 Qarz to'lash (Yopish)", `debt:pay:${firstId}`).row()
    .url('📤 Mijozga eslatma yuborish', `https://t.me/share/url?url=${encodeURIComponent(shareText)}`).row()
    .text('🔙 Orqaga', 'debt:back');

  await replyOrEdit(ctx, `👤 **Mijoz:** ${name}\n\n${lines}\n\n💰 **Umumiy qarz:** ${formatMoney(total)}`, kb, true);
});

debtHandler.callbackQuery(/^debt:pay:(.+)$/, async (ctx) => {
  const firstId = ctx.match[1];
  const firstDebt = await prisma.customerDebt.findUnique({ where: { id: firstId }, select: { customerName: true } });
  if (!firstDebt) return ctx.answerCallbackQuery('Mijoz topilmadi.');

  const agg = await prisma.customerDebt.aggregate({
    where: { customerName: firstDebt.customerName, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    _sum: { amount: true, paidAmount: true }
  });
  const totalRem = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);

  ctx.session.step = 'DEBT_PAYMENT';
  ctx.session.tempData = { customerName: firstDebt.customerName, firstId, totalRem };

  const kb = totalRem > 0
    ? new InlineKeyboard()
        .text(`💯 To'liq yopish (${formatMoney(totalRem)})`, `debt:qpay:${firstId}:${totalRem}`).row()
        .text(`🌓 Yarmini yopish (${formatMoney(Math.round(totalRem / 2))})`, `debt:qpay:${firstId}:${Math.round(totalRem / 2)}`)
    : undefined;

  await ctx.reply(`💸 **${firstDebt.customerName}** tomonidan to'langan summani raqamda kiriting:\n(Masalan: 50000 yoki 50 ming)`, { parse_mode: 'Markdown', reply_markup: kb });
});

debtHandler.callbackQuery(/^debt:qpay:(.+):(\d+)$/, async (ctx) => {
  const [, firstId, rawAmt] = ctx.match;
  const payAmount = Number(rawAmt);
  const firstDebt = await prisma.customerDebt.findUnique({ where: { id: firstId }, select: { customerName: true } });
  if (!firstDebt || !payAmount) return ctx.answerCallbackQuery('Topilmadi');

  const customerName = firstDebt.customerName;
  const remainingTotal = await applyCustomerPaymentFIFO(customerName, payAmount);
  clearSession(ctx);

  const suffix = remainingTotal > 0 ? `💰 **Qolgan nasiya summasi:** ${formatMoney(remainingTotal)}` : `🎉 **${customerName} barcha qarzlarini to'liq yopdi!**`;
  await ctx.editMessageText(`✅ **${customerName}** tomonidan **${formatMoney(payAmount)}** to'lov qabul qilindi!\n\n${suffix}`, {
    parse_mode: 'Markdown',
    reply_markup: new InlineKeyboard().text("👥 Nasiyadorlar ro'yxatiga qaytish", 'debt:back')
  });
});

debtHandler.callbackQuery('debt:new', async (ctx) => {
  ctx.session.step = 'ADD_DEBT_TEMPLATE';
  await ctx.reply(
    `👇 **"Shablonni to'ldirish"** tugmasini bosing yoki shunchaki oddiy matnda yozing (masalan: \`Alisher 120000 non va yog'\`)!`,
    { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().switchInlineCurrent("✍️ Shablonni to'ldirish", `Operatsiya: Nasiya\nMijoz: \nSumma: \nTelefon: \nIzoh: `) }
  );
});

debtHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step === 'DEBT_PAYMENT') {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return next();
    const payAmount = parseAmount(rawText);
    if (!payAmount || payAmount <= 0 || isNaN(payAmount)) {
      return ctx.reply("❌ To'g'ri to'lov summasini kiriting (masalan: 50000 yoki 50 ming). To'xtatish uchun /start.");
    }

    const { customerName } = ctx.session.tempData;
    const remainingTotal = await applyCustomerPaymentFIFO(customerName, payAmount);
    clearSession(ctx);
    const suffix = remainingTotal > 0 ? `💰 **Qolgan nasiya summasi:** ${formatMoney(remainingTotal)}` : `🎉 **${customerName} barcha qarzlarini to'liq yopdi!**`;
    return ctx.reply(`✅ **${customerName}** tomonidan **${formatMoney(payAmount)}** to'lov qabul qilindi!\n\n${suffix}`, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text("👥 Nasiyadorlar ro'yxatiga qaytish", 'debt:back') });
  }

  if (ctx.session.step !== 'ADD_DEBT_TEMPLATE') return next();
  const text = ctx.message.text;
  if (!text.includes('Operatsiya: Nasiya') && !text.includes('Mijoz:')) { ctx.session.step = undefined; return next(); }

  const customerName = text.match(/Mijoz:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const amount = Number((text.match(/Summa:\s*([^\n]+)/i)?.[1] || '').replace(/\D/g, ''));
  const phone = text.match(/Telefon:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const note = text.match(/Izoh:\s*([\s\S]+)/i)?.[1]?.trim() || '';

  if (!customerName) return ctx.reply("❌ Mijoz ismini aniqlab bo'lmadi.");
  if (!amount) return ctx.reply('❌ Summani aniqlab bo\'lmadi. Iltimos, raqamlarda kiriting.');

  const actionId = `debt_conf_${Date.now()}`;
  ctx.session.tempData = { type: 'DEBT_TEMPLATE', data: { amount, customerName, phone, note } };
  ctx.session.step = actionId;

  const confirmText = `🧾 *Nasiya Tahlili:*\n▫️ *Operatsiya:* Nasiya savdo\n▫️ *Mijoz:* ${customerName}\n▫️ *Summa:* ${formatMoney(amount)}\n${phone ? `▫️ *Telefon:* ${phone}\n` : ''}${note ? `▫️ *Izoh:* ${note}\n` : ''}\nMa'lumotlar to'g'rimi?`;
  await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: getTemplateConfirmKeyboard('debt:edit', actionId) });
});

registerTemplateActions(debtHandler, 'debt', 'ADD_DEBT_TEMPLATE', 'DEBT_TEMPLATE', async (_ctx, { amount, customerName, phone, note }) => {
  await prisma.customerDebt.create({ data: { customerName, amount, phone: phone || null, itemsSummary: note || null } });
  const agg = await prisma.customerDebt.aggregate({ where: { customerName }, _sum: { amount: true, paidAmount: true } });
  const totalRemaining = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);
  return `✅ Nasiya saqlandi: ${customerName} (+${formatMoney(amount)})\n💰 Yangilangan umumiy qarz: ${formatMoney(totalRemaining)}${note ? `\n📝 Izoh: ${note}` : ''}`;
});
