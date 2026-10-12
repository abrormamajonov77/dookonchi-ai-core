import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney, formatDate, formatCompactAmount } from '../../utils/formatters';
import { AiService } from '../../services/ai.service';
import { getConfirmationKeyboard } from '../keyboards/inline';

export const debtHandler = new Composer<MyContext>();

const ITEMS_PER_PAGE = 10;

async function sendDebtorsPage(ctx: MyContext, page: number, isEdit: boolean = false) {
  const debts = await prisma.customerDebt.findMany({
    where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    orderBy: { createdAt: 'desc' }
  });

  const keyboard = new InlineKeyboard();

  if (debts.length === 0) {
    keyboard.text("➕ Nasiya qo'shish", "debt:new");
    if (isEdit && ctx.callbackQuery?.message) {
      await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, 'Nasiyalar mavjud emas.', { reply_markup: keyboard });
    } else {
      await ctx.reply('Nasiyalar mavjud emas.', { reply_markup: keyboard });
    }
    return;
  }

  let total = 0;
  const grouped: Record<string, { sum: number, firstId: string }> = {};
  for (const debt of debts) {
    const remaining = Number(debt.amount) - Number(debt.paidAmount);
    if (remaining <= 0) continue;
    
    if (!grouped[debt.customerName]) {
      grouped[debt.customerName] = { sum: 0, firstId: debt.id };
    }
    grouped[debt.customerName].sum += remaining;
    total += remaining;
  }

  const groupedArray = Object.entries(grouped).sort((a, b) => b[1].sum - a[1].sum);
  const totalPages = Math.ceil(groupedArray.length / ITEMS_PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  
  const pageItems = groupedArray.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  let text = `👥 **Nasiyadorlar (Sahifa ${currentPage}/${totalPages})**\n`;
  text += `Jami nasiya: ${formatMoney(total)}\n\n`;

  pageItems.forEach(([name, data], index) => {
    const displayIndex = (currentPage - 1) * ITEMS_PER_PAGE + index + 1;
    text += `${displayIndex}. **${name}**: ${formatMoney(data.sum)}\n`;
  });

  for (let i = 0; i < pageItems.length; i += 2) {
    const row = [];
    
    const [name1, data1] = pageItems[i];
    let shortName1 = name1.length > 12 ? name1.substring(0, 12) + '...' : name1;
    row.push(InlineKeyboard.text(`${shortName1} | ${formatCompactAmount(data1.sum)}`, `debt:v:${data1.firstId}`));

    if (i + 1 < pageItems.length) {
      const [name2, data2] = pageItems[i + 1];
      let shortName2 = name2.length > 12 ? name2.substring(0, 12) + '...' : name2;
      row.push(InlineKeyboard.text(`${shortName2} | ${formatCompactAmount(data2.sum)}`, `debt:v:${data2.firstId}`));
    }
    
    keyboard.row(...row);
  }

  const navRow = [];
  if (currentPage > 1) {
    navRow.push(InlineKeyboard.text('⬅️ Oldingi', `debt:p:${currentPage - 1}`));
  }
  navRow.push(InlineKeyboard.text(`${currentPage}/${totalPages}`, 'ignore'));
  if (currentPage < totalPages) {
    navRow.push(InlineKeyboard.text('Keyingi ➡️', `debt:p:${currentPage + 1}`));
  }
  
  if (navRow.length > 0) {
    keyboard.row(...navRow);
  }

  keyboard.row(
    InlineKeyboard.text('➕ Yangi', 'debt:new'),
    InlineKeyboard.text('🔙 Asosiy', 'menu:main')
  );

  if (isEdit && ctx.callbackQuery?.message) {
    await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

debtHandler.hears('👥 Nasiyadorlar', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;
  await sendDebtorsPage(ctx, 1);
});

debtHandler.callbackQuery(/^debt:p:(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  await sendDebtorsPage(ctx, page, true);
});

// View specific debtor
debtHandler.callbackQuery(/^debt:v:(.+)$/, async (ctx) => {
  const firstId = ctx.match[1];
  const firstDebt = await prisma.customerDebt.findUnique({ where: { id: firstId } });
  if (!firstDebt) return ctx.answerCallbackQuery("Topilmadi");

  const name = firstDebt.customerName;
  const debts = await prisma.customerDebt.findMany({
    where: { customerName: name, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
    orderBy: { createdAt: 'desc' }
  });

  let text = `👤 **Mijoz:** ${name}\n\n`;
  let total = 0;
  for (const debt of debts) {
    const remaining = Number(debt.amount) - Number(debt.paidAmount);
    text += `🔹 ${formatDate(debt.createdAt)} | **${formatMoney(remaining, debt.currency)}**\n`;
    if (debt.itemsSummary) text += `   📝 ${debt.itemsSummary}\n`;
    total += remaining;
  }
  text += `\n💰 **Umumiy qarz:** ${formatMoney(total)}`;

  // Encode the name in base64 to avoid weird characters in callback query, or just pass id again.
  // Actually, for prefilled template, we can just use the name directly in switchInlineCurrent!
  const inlineTemplate = `Operatsiya: Nasiya\nMijoz: ${name}\nSumma: \nTelefon: \nIzoh: `;
  
  const keyboard = new InlineKeyboard()
    .switchInlineCurrent("➕ Yangi qarz qo'shish", inlineTemplate)
    .row()
    .text("🔙 Orqaga", "debt:back");


  if (ctx.callbackQuery.message) {
    await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
});

debtHandler.callbackQuery('debt:back', async (ctx) => {
  // Re-trigger the main list
  ctx.message = { text: '👥 Nasiyadorlar' } as any; 
  // Easy way is to just call the logic again, but since it's a composer, we can just edit message.
  // I will just answer it and let the user click the menu again, or extract the list logic.

  await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message!.message_id);
  // We can just execute the hears handler manually or rewrite. Since we don't have access to the hears handler directly, let's just ask them to use the menu.
  await ctx.reply("Iltimos, menyudan '👥 Nasiyadorlar' ni qayta tanlang.");
});

// Trigger Template
debtHandler.callbackQuery('debt:new', async (ctx) => {
  ctx.session.step = 'ADD_DEBT_TEMPLATE';
  
  const inlineTemplate = `Operatsiya: Nasiya\nMijoz: \nSumma: \nTelefon: \nIzoh: `;
  
  const templateKeyboard = new InlineKeyboard()
    .switchInlineCurrent("✍️ Shablonni to'ldirish", inlineTemplate);

  const template = `👇 **"Shablonni to'ldirish"** tugmasini bosing! 
Shunda shablon matni avtomatik ravishda yozish maydoningizga tushadi va siz faqat kerakli joylarini to'ldirib yuborasiz.

💡 *Eslatma:* Faqat Mijoz va Summa majburiy, qolgan maydonlar ixtiyoriy.`;


  await ctx.reply(template, { parse_mode: 'Markdown', reply_markup: templateKeyboard });
});

// Parse Text for Debt Template
debtHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'ADD_DEBT_TEMPLATE') return next();

  const text = ctx.message.text;
  let amount = 0;
  let customerName = '';
  let phone = '';
  let note = '';

  if (text.includes('Operatsiya: Nasiya') || text.includes('Mijoz:')) {
    // A) Regex Parsing
    const nameMatch = text.match(/Mijoz:\s*([^\n]+)/i);
    if (nameMatch) customerName = nameMatch[1].trim();
    
    const amountMatch = text.match(/Summa:\s*([^\n]+)/i);
    if (amountMatch) amount = Number(amountMatch[1].replace(/\D/g, ''));
    
    const phoneMatch = text.match(/Telefon:\s*([^\n]+)/i);
    if (phoneMatch) phone = phoneMatch[1].trim();
    
    const noteMatch = text.match(/Izoh:\s*([\s\S]+)/i);
    if (noteMatch) note = noteMatch[1].trim();
  } else {
    // B) Free text - let the general AI handler (voice.ts) handle it.
    ctx.session.step = undefined;
    return next();
  }

  if (!customerName) {
    return ctx.reply("❌ Mijoz ismini aniqlab bo'lmadi.");
  }
  if (!amount) {
    return ctx.reply("❌ Summani aniqlab bo'lmadi. Iltimos, raqamlarda kiriting.");
  }

  const actionId = `debt_conf_${Date.now()}`;
  ctx.session.tempData = {
    type: 'DEBT_TEMPLATE',
    data: { amount, customerName, phone, note }
  };
  ctx.session.step = actionId;

  let confirmText = `🧾 *Nasiya Tahlili:*\n`;
  confirmText += `▫️ *Operatsiya:* Nasiya savdo\n`;
  confirmText += `▫️ *Mijoz:* ${customerName}\n`;
  confirmText += `▫️ *Summa:* ${formatMoney(amount)}\n`;
  if (phone) confirmText += `▫️ *Telefon:* ${phone}\n`;
  if (note) confirmText += `▫️ *Izoh:* ${note}\n`;
  confirmText += `\nMa'lumotlar to'g'rimi?`;

  const customKeyboard = new InlineKeyboard()
    .text("✏️ Tahrirlash", `debt:edit`)
    .row()
    .text("✅ Tasdiqlash", `confirm_${actionId}`)
    .text("❌ Bekor qilish", `cancel_${actionId}`);

  await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: customKeyboard });
});

// Edit Debt Handler
debtHandler.callbackQuery('debt:edit', async (ctx) => {
  ctx.session.step = 'ADD_DEBT_TEMPLATE';

  await ctx.editMessageText("Qaytadan to'g'ri ma'lumotlarni yozib yuboring (Erkin matn yoki shablon):");
});

// Confirmation logic
debtHandler.callbackQuery(/^confirm_debt_conf_/, async (ctx) => {
  if (!ctx.session.tempData || ctx.session.tempData.type !== 'DEBT_TEMPLATE') {
    return ctx.answerCallbackQuery({ text: 'Eskirgan so\'rov!', show_alert: true });
  }

  const { amount, customerName, phone, note } = ctx.session.tempData.data;

  try {
    await prisma.customerDebt.create({
      data: {
        customerName,
        amount,
        phone: phone || null,
        itemsSummary: note || null
      }
    });
    const updatedDebts = await prisma.customerDebt.aggregate({
      where: { customerName },
      _sum: { amount: true, paidAmount: true }
    });
    const totalRemaining = Number(updatedDebts._sum.amount || 0) - Number(updatedDebts._sum.paidAmount || 0);

    let resText = `✅ Nasiya saqlandi: ${customerName} (+${formatMoney(amount)})\n`;
    resText += `💰 Yangilangan umumiy qarz: ${formatMoney(totalRemaining)}`;
    if (note) resText += `\n📝 Izoh: ${note}`;
    
    await ctx.editMessageText(resText);
    ctx.session.tempData = null;
    ctx.session.step = undefined;
  } catch (error) {
    await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi.", show_alert: true });
  }
});

debtHandler.callbackQuery(/^cancel_debt_conf_/, async (ctx) => {
  ctx.session.tempData = null;
  ctx.session.step = undefined;
  await ctx.editMessageText("❌ Bekor qilindi.");
});
