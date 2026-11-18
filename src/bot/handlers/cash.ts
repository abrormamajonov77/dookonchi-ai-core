import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney, formatDate, getToday } from '../../utils/formatters';
import { getTemplateConfirmKeyboard } from '../keyboards/inline';
import { clearSession, registerTemplateActions, safeReply, sanitizeMdV1 } from '../../utils/telegram';

export const cashHandler = new Composer<MyContext>();

cashHandler.hears('💵 Naqd', async (ctx) => {
  if (!ctx.from) return;
  clearSession(ctx);
  const ownerId = String(ctx.from.id);
  const now = new Date();
  const [recentTx, monthStats, dayStats] = await Promise.all([
    prisma.cashTransaction.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.cashTransaction.aggregate({
      where: { ownerId, createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } },
      _sum: { amount: true },
    }),
    prisma.cashTransaction.aggregate({
      where: { ownerId, createdAt: { gte: getToday() } },
      _sum: { amount: true },
    }),
  ]);

  const txLines = recentTx.length
    ? `📝 **Oxirgi 10 ta amaliyot:**\n` +
      recentTx
        .map(
          (tx) =>
            `🔹 ${formatDate(tx.createdAt)} | **${sanitizeMdV1(tx.partyName)}** - ${formatMoney(tx.amount)}${tx.items ? `\n   ✏️ ${sanitizeMdV1(tx.items).slice(0, 80)}` : ''}`
        )
        .join('\n')
    : "Amaliyotlar yo'q.";

  await safeReply(
    ctx,
    `💵 **Naqd Savdo va Xaridlar Arxiv:**\n\n📊 **Bugungi aylanma:** ${formatMoney(dayStats._sum.amount || 0)}\n📊 **Shu oydagi aylanma:** ${formatMoney(monthStats._sum.amount || 0)}\n\n${txLines}`,
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

  const partyName = text.match(/Kimdan\/Brend:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const amount = Number((text.match(/Summa:\s*([^\n]+)/i)?.[1] || '').replace(/\D/g, ''));
  const items = text.match(/Tovar\/Izoh:\s*([\s\S]+)/i)?.[1]?.trim() || '';
  if (!amount) return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");

  const actionId = `cash_conf_${Date.now()}`;
  ctx.session.tempData = { type: 'CASH_TEMPLATE', data: { amount, partyName, items } };
  ctx.session.step = actionId;

  const confirmText = `🧾 *Naqd Xarid Tahlili:*\n▫️ *Operatsiya:* Naqd\n▫️ *Kimdan:* ${partyName || "Noma'lum"}\n▫️ *Summa:* ${formatMoney(amount)}\n${items ? `▫️ *Tovar/Izoh:* ${items}\n` : ''}\n*(Bu operatsiya qarzlar balansiga ta'sir qilmaydi)*\nMa'lumotlar to'g'rimi?`;
  await ctx.reply(confirmText, {
    parse_mode: 'Markdown',
    reply_markup: getTemplateConfirmKeyboard('cash:edit', actionId),
  });
});

registerTemplateActions(
  cashHandler,
  'cash',
  'ADD_CASH_TEMPLATE',
  'CASH_TEMPLATE',
  async (ctx, { amount, partyName, items }) => {
    const ownerId = String(ctx.from?.id || '');
    await prisma.cashTransaction.create({
      data: { ownerId, partyName: partyName || "Noma'lum", amount, items: items || null, createdBy: ownerId },
    });
    return `✅ Naqd xarid saqlandi:\nKimdan: ${partyName || "Noma'lum"}\nSumma: ${formatMoney(amount)}${items ? `\nIzoh: ${items}` : ''}\n*(Ushbu summa qarzga ta'sir qilmadi)*`;
  }
);
