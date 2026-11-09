import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney } from '../../utils/formatters';
import { AiService } from '../../services/ai.service';
import { getTemplateConfirmKeyboard } from '../keyboards/inline';
import { registerTemplateActions } from '../../utils/telegram';

export const expenseHandler = new Composer<MyContext>();

expenseHandler.hears('📉 Xarajatlar', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;
  const now = new Date();
  const expenses = await prisma.expense.findMany({ where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } } });
  const kb = new InlineKeyboard().text('➕ Yangi xarajat', 'exp:new');
  if (!expenses.length) return ctx.reply("Bu oy uchun xarajatlar yo'q.", { reply_markup: kb });

  let total = 0;
  const byCategory: Record<string, number> = {};
  for (const exp of expenses) {
    total += Number(exp.amount);
    byCategory[exp.category] = (byCategory[exp.category] || 0) + Number(exp.amount);
  }
  const lines = Object.entries(byCategory).map(([cat, sum]) => `🔹 ${cat}: ${formatMoney(sum)}`).join('\n');
  await ctx.reply(`📉 **Shu oydagi xarajatlar:**\n\n${lines}\n\n**Jami: ${formatMoney(total)}**`, { parse_mode: 'Markdown', reply_markup: kb });
});

expenseHandler.callbackQuery('exp:new', async (ctx) => {
  ctx.session.step = 'ADD_EXPENSE_TEMPLATE';
  await ctx.reply(
    `👇 **"Shablonni to'ldirish"** tugmasini bosing!\nShunda shablon matni avtomatik ravishda yozish maydoningizga tushadi va siz faqat kerakli joylarini to'ldirib yuborasiz.\n\n💡 *Eslatma:* Faqat summa majburiy, qolgan barcha maydonlar ixtiyoriy. Masalan: shunchaki 50000 tushlik deb yozsangiz ham qabul qilinadi.`,
    { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().switchInlineCurrent("✍️ Shablonni to'ldirish", `Operatsiya: Xarajat\nSumma: \nKategoriya: \nIzoh: `) }
  );
});

expenseHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'ADD_EXPENSE_TEMPLATE') return next();
  const text = ctx.message.text;
  if (!text.includes('Operatsiya: Xarajat') && !text.includes('Summa:')) { ctx.session.step = undefined; return next(); }

  const amount = Number((text.match(/Summa:\s*(.+)/i)?.[1] || '').replace(/\D/g, ''));
  let category = text.match(/Kategoriya:\s*(.+)/i)?.[1]?.trim() || '';
  let note = text.match(/Izoh:\s*(.+)/i)?.[1]?.trim() || '';
  if (!amount) return ctx.reply('❌ Summani aniqlab bo\'lmadi. Iltimos, raqamlarda kiriting.');
  if (!category) category = (await AiService.parseTextIntent(`Operatsiya: Xarajat. Summa: ${amount}. Izoh: ${note}`)).category || 'Boshqa';
  if (!note || note.toLowerCase() === "yo'q" || note === '-') note = 'Kiritilmagan';

  const actionId = `exp_conf_${Date.now()}`;
  ctx.session.tempData = { type: 'EXPENSE_TEMPLATE', data: { amount, category, note } };
  ctx.session.step = actionId;

  const confirmText = `🧾 *Xarajat Tahlili:*\n▫️ *Operatsiya:* Xarajat\n▫️ *Summa:* ${formatMoney(amount)}\n▫️ *Kategoriya:* ${category}\n▫️ *Izoh:* ${note}\n\nMa'lumotlar to'g'rimi?`;
  await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: getTemplateConfirmKeyboard('exp:edit', actionId) });
});

registerTemplateActions(expenseHandler, 'exp', 'ADD_EXPENSE_TEMPLATE', 'EXPENSE_TEMPLATE', async (ctx, { amount, category, note }) => {
  await prisma.expense.create({ data: { amount, category, note, createdBy: ctx.user!.id } });
  return `✅ Xarajat saqlandi:\nSumma: ${formatMoney(amount)}\nKategoriya: ${category}\nIzoh: ${note}`;
});
