import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney } from '../../utils/formatters';
import { AiService } from '../../services/ai.service';
import { getConfirmationKeyboard } from '../keyboards/inline';

export const expenseHandler = new Composer<MyContext>();

expenseHandler.hears('📉 Xarajatlar', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const expenses = await prisma.expense.findMany({
    where: { createdAt: { gte: startOfMonth } }
  });

  const keyboard = new InlineKeyboard().text("➕ Yangi xarajat", "exp:new");

  if (expenses.length === 0) {
    return ctx.reply("Bu oy uchun xarajatlar yo'q.", { reply_markup: keyboard });
  }

  let total = 0;
  const byCategory: Record<string, number> = {};

  for (const exp of expenses) {
    const amt = Number(exp.amount);
    total += amt;
    byCategory[exp.category] = (byCategory[exp.category] || 0) + amt;
  }

  let text = '📉 **Shu oydagi xarajatlar:**\n\n';
  for (const [cat, sum] of Object.entries(byCategory)) {
    text += `🔹 ${cat}: ${formatMoney(sum)}\n`;
  }
  text += `\n**Jami: ${formatMoney(total)}**`;

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// Trigger Template
expenseHandler.callbackQuery('exp:new', async (ctx) => {
  ctx.session.step = 'ADD_EXPENSE_TEMPLATE';
  
  const inlineTemplate = `Operatsiya: Xarajat\nSumma: \nKategoriya: \nIzoh: `;
  
  const templateKeyboard = new InlineKeyboard()
    .switchInlineCurrent("✍️ Shablonni to'ldirish", inlineTemplate);

  const template = `👇 **"Shablonni to'ldirish"** tugmasini bosing! 
Shunda shablon matni avtomatik ravishda yozish maydoningizga tushadi va siz faqat kerakli joylarini to'ldirib yuborasiz.

💡 *Eslatma:* Faqat summa majburiy, qolgan barcha maydonlar ixtiyoriy. Masalan: shunchaki 50000 tushlik deb yozsangiz ham qabul qilinadi.`;


  await ctx.reply(template, { parse_mode: 'Markdown', reply_markup: templateKeyboard });
});

// Parse Text for Expense Template
expenseHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'ADD_EXPENSE_TEMPLATE') return next();

  const text = ctx.message.text;
  let amount = 0;
  let category = '';
  let note = '';

  if (text.includes('Operatsiya: Xarajat') || text.includes('Summa:')) {
    // A) Regex Parsing
    const amountMatch = text.match(/Summa:\s*(.+)/i);
    if (amountMatch) amount = Number(amountMatch[1].replace(/\D/g, ''));
    
    const catMatch = text.match(/Kategoriya:\s*(.+)/i);
    if (catMatch) category = catMatch[1].trim();
    
    const noteMatch = text.match(/Izoh:\s*(.+)/i);
    if (noteMatch) note = noteMatch[1].trim();
  } else {
    // B) Free text - let the general AI handler (voice.ts) handle it,
    // because it might be a completely different intent (like Supplier Payment).
    ctx.session.step = undefined;
    return next();
  }

  if (!amount) {
    return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");
  }

  // Auto-categorize if empty using AI
  if (!category) {
    const aiData = await AiService.parseTextIntent(`Operatsiya: Xarajat. Summa: ${amount}. Izoh: ${note}`);
    category = aiData.category || 'Boshqa';
  }
  
  if (!note || note.toLowerCase() === "yo'q" || note === "-") {
    note = "Kiritilmagan";
  }

  const actionId = `exp_conf_${Date.now()}`;
  ctx.session.tempData = {
    type: 'EXPENSE_TEMPLATE',
    data: { amount, category, note }
  };
  ctx.session.step = actionId;

  const confirmText = `🧾 *Xarajat Tahlili:*\n▫️ *Operatsiya:* Xarajat\n▫️ *Summa:* ${formatMoney(amount)}\n▫️ *Kategoriya:* ${category}\n▫️ *Izoh:* ${note}\n\nMa'lumotlar to'g'rimi?`;

  const customKeyboard = new InlineKeyboard()
    .text("✏️ Tahrirlash", `exp:edit`)
    .row()
    .text("✅ Tasdiqlash", `confirm_${actionId}`)
    .text("❌ Bekor qilish", `cancel_${actionId}`);

  await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: customKeyboard });
});

// Edit Expense Handler
expenseHandler.callbackQuery('exp:edit', async (ctx) => {
  ctx.session.step = 'ADD_EXPENSE_TEMPLATE';

  await ctx.editMessageText("Qaytadan to'g'ri ma'lumotlarni yozib yuboring (Erkin matn yoki shablon):");
});

// Confirmation logic
expenseHandler.callbackQuery(/^confirm_exp_conf_/, async (ctx) => {
  if (!ctx.session.tempData || ctx.session.tempData.type !== 'EXPENSE_TEMPLATE') {
    return ctx.answerCallbackQuery({ text: 'Eskirgan so\'rov!', show_alert: true });
  }

  const { amount, category, note } = ctx.session.tempData.data;

  try {
    await prisma.expense.create({
      data: {
        amount,
        category,
        note,
        createdBy: ctx.user!.id
      }
    });

    await ctx.editMessageText(`✅ Xarajat saqlandi:\nSumma: ${formatMoney(amount)}\nKategoriya: ${category}\nIzoh: ${note}`);
    ctx.session.tempData = null;
    ctx.session.step = undefined;
  } catch (error) {
    await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi.", show_alert: true });
  }
});

expenseHandler.callbackQuery(/^cancel_exp_conf_/, async (ctx) => {
  ctx.session.tempData = null;
  ctx.session.step = undefined;
  await ctx.editMessageText("❌ Bekor qilindi.");
});
