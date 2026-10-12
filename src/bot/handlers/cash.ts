import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney, formatDate } from '../../utils/formatters';
import { AiService } from '../../services/ai.service';

export const cashHandler = new Composer<MyContext>();

cashHandler.hears('💵 Naqd', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [recentTx, monthStats, dayStats] = await Promise.all([
    prisma.cashTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10
    }),
    prisma.cashTransaction.aggregate({
      where: { createdAt: { gte: startOfMonth } },
      _sum: { amount: true }
    }),
    prisma.cashTransaction.aggregate({
      where: { createdAt: { gte: startOfDay } },
      _sum: { amount: true }
    })
  ]);

  const monthTotal = Number(monthStats._sum.amount || 0);
  const dayTotal = Number(dayStats._sum.amount || 0);

  let text = `💵 **Naqd Savdo va Xaridlar Arxiv:**\n\n`;
  text += `📊 **Bugungi aylanma:** ${formatMoney(dayTotal)}\n`;
  text += `📊 **Shu oydagi aylanma:** ${formatMoney(monthTotal)}\n\n`;

  if (recentTx.length > 0) {
    text += `📝 **Oxirgi 10 ta amaliyot:**\n`;
    for (const tx of recentTx) {
      text += `🔹 ${formatDate(tx.createdAt)} | **${tx.partyName}** - ${formatMoney(Number(tx.amount))}\n`;
      if (tx.items) text += `   ✏️ ${tx.items}\n`;
    }
  } else {
    text += `Amaliyotlar yo'q.`;
  }

  const keyboard = new InlineKeyboard()
    .text("➕ Yangi naqd xarid", "cash:new");

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// Trigger Template
cashHandler.callbackQuery('cash:new', async (ctx) => {
  ctx.session.step = 'ADD_CASH_TEMPLATE';
  
  const inlineTemplate = `Operatsiya: Naqd xarid\nKimdan/Brend: \nSumma: \nTovar/Izoh: `;
  
  const templateKeyboard = new InlineKeyboard()
    .switchInlineCurrent("✍️ Shablonni to'ldirish", inlineTemplate);

  const template = `👇 **"Shablonni to'ldirish"** tugmasini bosing! 
Shunda shablon matni avtomatik ravishda yozish maydoningizga tushadi va siz faqat kerakli joylarini to'ldirib yuborasiz.

💡 *Eslatma:* Siz oddiy matn orqali (masalan: "Naqdga 200 ming shakar oldik") yozsangiz ham bot buni to'g'ri tushunadi.`;


  await ctx.reply(template, { parse_mode: 'Markdown', reply_markup: templateKeyboard });
});

// Parse Text for Cash Template
cashHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'ADD_CASH_TEMPLATE') return next();

  const text = ctx.message.text;
  let amount = 0;
  let partyName = '';
  let items = '';

  if (text.includes('Operatsiya: Naqd xarid')) {
    // A) Regex Parsing
    const nameMatch = text.match(/Kimdan\/Brend:\s*([^\n]+)/i);
    if (nameMatch) partyName = nameMatch[1].trim();
    
    const amountMatch = text.match(/Summa:\s*([^\n]+)/i);
    if (amountMatch) amount = Number(amountMatch[1].replace(/\D/g, ''));
    
    const noteMatch = text.match(/Tovar\/Izoh:\s*([\s\S]+)/i);
    if (noteMatch) items = noteMatch[1].trim();
  } else {
    // B) Free text - let the general AI handler (voice.ts) handle it.
    ctx.session.step = undefined;
    return next();
  }

  if (!amount) {
    return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");
  }

  const actionId = `cash_conf_${Date.now()}`;
  ctx.session.tempData = {
    type: 'CASH_TEMPLATE',
    data: { amount, partyName, items }
  };
  ctx.session.step = actionId;

  let confirmText = `🧾 *Naqd Xarid Tahlili:*\n`;
  confirmText += `▫️ *Operatsiya:* Naqd\n`;
  confirmText += `▫️ *Kimdan:* ${partyName || "Noma'lum"}\n`;
  confirmText += `▫️ *Summa:* ${formatMoney(amount)}\n`;
  if (items) confirmText += `▫️ *Tovar/Izoh:* ${items}\n`;
  confirmText += `\n*(Bu operatsiya qarzlar balansiga ta'sir qilmaydi)*\nMa'lumotlar to'g'rimi?`;

  const customKeyboard = new InlineKeyboard()
    .text("✏️ Tahrirlash", `cash:edit`)
    .row()
    .text("✅ Tasdiqlash", `confirm_${actionId}`)
    .text("❌ Bekor qilish", `cancel_${actionId}`);

  await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: customKeyboard });
});

// Edit Cash Handler
cashHandler.callbackQuery('cash:edit', async (ctx) => {
  ctx.session.step = 'ADD_CASH_TEMPLATE';

  await ctx.editMessageText("Qaytadan to'g'ri ma'lumotlarni yozib yuboring (Erkin matn yoki shablon):");
});

// Confirmation logic
cashHandler.callbackQuery(/^confirm_cash_conf_/, async (ctx) => {
  if (!ctx.session.tempData || ctx.session.tempData.type !== 'CASH_TEMPLATE') {
    return ctx.answerCallbackQuery({ text: 'Eskirgan so\'rov!', show_alert: true });
  }

  const { amount, partyName, items } = ctx.session.tempData.data;

  try {
    await prisma.cashTransaction.create({
      data: {
        partyName: partyName || "Noma'lum",
        amount,
        items: items || null
      }
    });

    let resText = `✅ Naqd xarid saqlandi:\nKimdan: ${partyName || "Noma'lum"}\nSumma: ${formatMoney(amount)}`;
    if (items) resText += `\nIzoh: ${items}`;
    resText += `\n*(Ushbu summa qarzga ta'sir qilmadi)*`;
    
    await ctx.editMessageText(resText);
    ctx.session.tempData = null;
    ctx.session.step = undefined;
  } catch (error) {
    await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi.", show_alert: true });
  }
});

cashHandler.callbackQuery(/^cancel_cash_conf_/, async (ctx) => {
  ctx.session.tempData = null;
  ctx.session.step = undefined;
  await ctx.editMessageText("❌ Bekor qilindi.");
});
