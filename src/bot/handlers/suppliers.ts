import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney, formatDate, formatCompactAmount } from '../../utils/formatters';
import { SupplierService } from '../../services/supplier.service';
import { cacheService } from '../../services/cache.service';

export const suppliersHandler = new Composer<MyContext>();

const ITEMS_PER_PAGE = 5;

// Main list
suppliersHandler.hears("📦 Ta'minotchilar", async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;
  await sendSuppliersPage(ctx, 1);
});

// Pagination callback
suppliersHandler.callbackQuery(/^sup:p:(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  await sendSuppliersPage(ctx, page, true);

});

// View Supplier Profile
suppliersHandler.callbackQuery(/^sup:v:(.+)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  await sendSupplierDetails(ctx, supplierId, 'all', true);

});

// Archive Supplier
suppliersHandler.callbackQuery(/^sup:archive:(.+)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  if (ctx.user?.role !== 'OWNER') {
    return ctx.answerCallbackQuery({ text: "Sizda ushbu amal uchun huquq yo'q!", show_alert: true });
  }
  
  await prisma.supplier.update({
    where: { id: supplierId },
    data: { isActive: false }
  });
  
  await ctx.answerCallbackQuery({ text: "Ta'minotchi o'chirildi (Arxivlandi)." });
  await sendSuppliersPage(ctx, 1, true);
});

// View Supplier Transactions with Filter
suppliersHandler.callbackQuery(/^sup:tx:(.+):(all|month|today)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  const filter = ctx.match[2] as 'all' | 'month' | 'today';
  await sendSupplierDetails(ctx, supplierId, filter, true);

});

// Helper: Send Suppliers Page
async function sendSuppliersPage(ctx: MyContext, page: number, isEdit: boolean = false) {
  const ITEMS_PER_PAGE = 10;
  const totalCount = await prisma.supplier.count({ where: { isActive: true } });
  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true },
    orderBy: { debtUzs: 'desc' },
    skip: (currentPage - 1) * ITEMS_PER_PAGE,
    take: ITEMS_PER_PAGE,
  });

  const totalDebtResult = await prisma.supplier.aggregate({
    where: { isActive: true },
    _sum: { debtUzs: true }
  });
  const totalDebt = totalDebtResult._sum.debtUzs || 0;

  let text = `📦 **Ta'minotchilar (Sahifa ${currentPage}/${totalPages})**\n`;
  text += `Jami qarzimiz: ${formatMoney(Number(totalDebt))}\n\n`;
  
  if (suppliers.length > 0) {
    suppliers.forEach((sup, index) => {
      const displayIndex = (currentPage - 1) * ITEMS_PER_PAGE + index + 1;
      text += `${displayIndex}. **${sup.name}**: ${formatMoney(Number(sup.debtUzs))}\n`;
    });
  } else {
    text += `Hozircha ta'minotchilar yo'q.\n`;
  }

  const keyboard = new InlineKeyboard();

  for (let i = 0; i < suppliers.length; i += 2) {
    const row = [];
    
    // First column
    const sup1 = suppliers[i];
    let name1 = sup1.name.length > 12 ? sup1.name.substring(0, 12) + '...' : sup1.name;
    row.push(InlineKeyboard.text(`${name1} | ${formatCompactAmount(Number(sup1.debtUzs))}`, `sup:v:${sup1.id}`));

    // Second column (if exists)
    if (i + 1 < suppliers.length) {
      const sup2 = suppliers[i + 1];
      let name2 = sup2.name.length > 12 ? sup2.name.substring(0, 12) + '...' : sup2.name;
      row.push(InlineKeyboard.text(`${name2} | ${formatCompactAmount(Number(sup2.debtUzs))}`, `sup:v:${sup2.id}`));
    }
    
    keyboard.row(...row);
  }

  // Pagination buttons
  const navRow = [];
  if (currentPage > 1) {
    navRow.push(InlineKeyboard.text('⬅️ Oldingi', `sup:p:${currentPage - 1}`));
  }
  navRow.push(InlineKeyboard.text(`${currentPage}/${totalPages}`, 'ignore'));
  if (currentPage < totalPages) {
    navRow.push(InlineKeyboard.text('Keyingi ➡️', `sup:p:${currentPage + 1}`));
  }
  
  if (navRow.length > 0) {
    keyboard.row(...navRow);
  }

  keyboard.row(
    InlineKeyboard.text('➕ Yangi', 'sup:add'),
    InlineKeyboard.text('🔙 Asosiy', 'menu:main') // Assuming a main menu callback exists, or we just rely on bottom keyboard
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

// Helper: Send Supplier Details
async function sendSupplierDetails(ctx: MyContext, supplierId: string, filter: 'all' | 'month' | 'today', isEdit: boolean = false) {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId }
  });

  if (!supplier) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
    return;
  }

  const now = new Date();
  let startDate: Date | undefined;

  if (filter === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (filter === 'month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const txWhere: any = { supplierId };
  if (startDate) {
    txWhere.date = { gte: startDate };
  }

  // Calculate check numbers (only INCOMING_GOODS)
  const allIncoming = await prisma.supplierTransaction.findMany({
    where: { supplierId, type: 'INCOMING_GOODS' },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, amount: true }
  });

  const txStats = await prisma.supplierTransaction.groupBy({
    by: ['type'],
    where: txWhere,
    _sum: { amount: true }
  });

  let totalIncoming = 0;
  let totalPayment = 0;
  txStats.forEach(stat => {
    if (stat.type === 'INCOMING_GOODS') totalIncoming = Number(stat._sum.amount || 0);
    if (stat.type === 'PAYMENT') totalPayment = Number(stat._sum.amount || 0);
  });

  let text = `🏢 **Ta'minotchi:** ${supplier.name}\n`;
  text += `📞 **Tel:** ${supplier.phone || "Yo'q"}\n`;
  
  const currentBalance = Number(supplier.debtUzs);
  if (currentBalance >= 0) {
    text += `💰 **Qarzimiz:** ${formatMoney(currentBalance)}\n\n`;
  } else {
    text += `🟢 **Bizning haqimiz:** ${formatMoney(Math.abs(currentBalance))}\n\n`;
  }

  const filterText = filter === 'today' ? 'Bugun' : filter === 'month' ? 'Shu oy' : 'Barcha vaqt';
  text += `📊 **Statistika (${filterText}):**\n`;
  text += `📥 Kirim: ${formatMoney(totalIncoming)}\n`;
  text += `📤 To'lov: ${formatMoney(totalPayment)}\n\n`;

  const totalChecks = allIncoming.length;

  const keyboard = new InlineKeyboard()
    .text(filter === 'today' ? '✅ Bugun' : 'Bugun', `sup:tx:${supplier.id}:today`)
    .text(filter === 'month' ? '✅ Shu oy' : 'Shu oy', `sup:tx:${supplier.id}:month`)
    .text(filter === 'all' ? '✅ Barcha' : 'Barcha', `sup:tx:${supplier.id}:all`)
    .row();

  // Show last 3 checks
  if (totalChecks > 0) {
    const last3 = allIncoming.slice(-3).reverse();
    last3.forEach(tx => {
      const idx = allIncoming.findIndex(i => i.id === tx.id) + 1;
      const dateStr = new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(tx.date);
      const shortAmount = formatCompactAmount(Number(tx.amount));
      keyboard.text(`📄 Chek #${idx} (${dateStr} | ${shortAmount})`, `sup:receipt:${tx.id}`).row();
    });

    if (totalChecks > 3) {
      keyboard.text(`📂 Barcha cheklar tarixi (Jami: ${totalChecks} ta)`, `sup:receipts:list:${supplier.id}:1`).row();
    }
  }

  keyboard.text("📦 Yuk olish (Kirim)", `sup:goods:${supplier.id}`)
    .text("💸 To'lov qilish", `sup:pay:${supplier.id}`)
    .row()
    .text("🛑 Faoliyatni to'xtatish (Arxivlash)", `sup:archive:${supplier.id}`)
    .row()
    .text("🔙 Ro'yxatga qaytish", 'sup:p:1');

  if (isEdit && ctx.callbackQuery?.message) {
    await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// Handle Receipts Pagination
suppliersHandler.callbackQuery(/^sup:receipts:list:(.+):(\d+)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  const page = parseInt(ctx.match[2], 10) || 1;
  const ITEMS_PER_PAGE = 5;

  const allIncoming = await prisma.supplierTransaction.findMany({
    where: { supplierId, type: 'INCOMING_GOODS' },
    orderBy: { date: 'asc' }, // Get all in asc to find their real index
    select: { id: true, date: true, amount: true }
  });

  const totalPages = Math.ceil(allIncoming.length / ITEMS_PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  // Reverse to show latest first
  const reversed = [...allIncoming].reverse();
  const pageItems = reversed.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  let text = `📂 **Barcha cheklar tarixi (Sahifa ${currentPage}/${totalPages})**\n\nQuyidagi cheklardan birini tanlang:`;

  const keyboard = new InlineKeyboard();

  pageItems.forEach(tx => {
    const idx = allIncoming.findIndex(i => i.id === tx.id) + 1;
    const dateStr = new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(tx.date);
    const shortAmount = formatCompactAmount(Number(tx.amount));
    keyboard.text(`📄 Chek #${idx} (${dateStr} | ${shortAmount})`, `sup:receipt:${tx.id}`).row();
  });

  const navRow = [];
  if (currentPage > 1) {
    navRow.push(InlineKeyboard.text('⬅️ Oldingi', `sup:receipts:list:${supplierId}:${currentPage - 1}`));
  }
  navRow.push(InlineKeyboard.text(`${currentPage}/${totalPages}`, 'ignore'));
  if (currentPage < totalPages) {
    navRow.push(InlineKeyboard.text('Keyingi ➡️', `sup:receipts:list:${supplierId}:${currentPage + 1}`));
  }
  if (navRow.length > 0) keyboard.row(...navRow);

  keyboard.text("🔙 Orqaga", `sup:v:${supplierId}`).row();

  await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message!.message_id, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// View Receipt
suppliersHandler.callbackQuery(/^sup:receipt:(.+)$/, async (ctx) => {
  const txId = ctx.match[1];
  const tx = await prisma.supplierTransaction.findUnique({ 
    where: { id: txId },
    include: { supplier: true }
  });
  
  if (!tx) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery("Ushbu amaliyot topilmadi.");
    return;
  }

  const allIncoming = await prisma.supplierTransaction.findMany({
    where: { supplierId: tx.supplierId, type: 'INCOMING_GOODS' },
    orderBy: { date: 'asc' },
    select: { id: true }
  });
  const checkNumber = allIncoming.findIndex(i => i.id === tx.id) + 1;

  let formattedReceipt = tx.formattedReceipt;
  
  if (!formattedReceipt) {
    formattedReceipt = `🧾 NAKLADNOY CHEK #${checkNumber}\n🏢 Ta'minotchi: ${tx.supplier.name}\n📅 Sana: ${new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(tx.date)}\n💰 Summa: ${formatMoney(Number(tx.amount))}\n`;
    if (tx.description) {
      formattedReceipt += `\nIzoh: ${tx.description}`;
    }
  } else {
    formattedReceipt = formattedReceipt.replace('🧾 ELEKTRON NAKLADNOY', `🧾 NAKLADNOY CHEK #${checkNumber}`);
  }

  const keyboard = new InlineKeyboard();
  keyboard.text("🔙 Cheklar ro'yxatiga qaytish", `sup:receipts:list:${tx.supplierId}:1`).row();
  
  if (tx.photoFileId) {
    keyboard.text("🖼 Asl rasmni ko'rish", `sup:photo:${tx.id}`).row();
  }
  
  await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message!.message_id, `\`\`\`\n${formattedReceipt}\n\`\`\``, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

suppliersHandler.callbackQuery('close_msg', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
});

// View Photo
suppliersHandler.callbackQuery(/^sup:photo:(.+)$/, async (ctx) => {
  const txId = ctx.match[1];
  const tx = await prisma.supplierTransaction.findUnique({ where: { id: txId } });
  
  if (!tx || !tx.photoFileId) {
    return ctx.answerCallbackQuery("Asl rasm topilmadi yoki o'chirilgan.");
  }


  await ctx.replyWithPhoto(tx.photoFileId, {
    caption: "🖼 Asl nakladnoy rasmi",
    reply_markup: new InlineKeyboard().text('🗑 Yopish', 'close_msg')
  });
});


// Add New Supplier
suppliersHandler.callbackQuery('sup:add', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') {
    return ctx.answerCallbackQuery({ text: "Sizda ushbu amal uchun huquq yo'q!", show_alert: true });
  }

  ctx.session.step = 'SUPPLIER_ADD';
  ctx.session.tempData = {};

  await ctx.reply(
    "➕ **Yangi ta'minotchi qo'shish**\n\n" +
    "Ta'minotchi nomi va ixtiyoriy telefon raqamini kiriting:\n" +
    "(Masalan: `Azamat Shakar +998901234567` yoki shunchaki `Azamat Shakar`)\n\n" +
    "Bekor qilish uchun /start ni bosing.",
    { parse_mode: 'Markdown' }
  );
});

// Trigger Manual Payment
suppliersHandler.callbackQuery(/^sup:pay:(.+)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  ctx.session.step = 'SUPPLIER_PAYMENT';
  ctx.session.tempData = { supplierId, supplierName: supplier.name, action: 'PAYMENT' };


  await ctx.reply(`💸 **${supplier.name}** ga to'langan pul summasini raqamlarda kiriting:\n(Masalan: 500000 yoki 500 000)`, {
    parse_mode: 'Markdown'
  });
});

// Trigger Incoming Goods
suppliersHandler.callbackQuery(/^sup:goods:(.+)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  ctx.session.step = 'SUPPLIER_GOODS';
  ctx.session.tempData = { supplierId, supplierName: supplier.name, action: 'INCOMING_GOODS' };


  await ctx.reply(`📦 **${supplier.name}** dan qabul qilingan yuk summasini raqamlarda kiriting:\n(Masalan: 500000 yoki 500 000)`, {
    parse_mode: 'Markdown'
  });
});

// Undo Transaction
suppliersHandler.callbackQuery(/^sup:undo:(.+)$/, async (ctx) => {
  const txId = ctx.match[1];
  
  const transaction = await prisma.supplierTransaction.findUnique({ where: { id: txId } });
  if (!transaction) return ctx.answerCallbackQuery("Bu amaliyot topilmadi yoki allaqachon bekor qilingan.");

  await prisma.$transaction(async (tx) => {
    // Reverse the balance impact
    if (transaction.type === 'INCOMING_GOODS') {
      await tx.supplier.update({
        where: { id: transaction.supplierId },
        data: { debtUzs: { decrement: transaction.amount } }
      });
    } else if (transaction.type === 'PAYMENT') {
      await tx.supplier.update({
        where: { id: transaction.supplierId },
        data: { debtUzs: { increment: transaction.amount } }
      });
    }

    // Delete the transaction
    await tx.supplierTransaction.delete({ where: { id: txId } });
  });

  await ctx.answerCallbackQuery("Amaliyot bekor qilindi va balans tiklandi!");
  
  // Refresh the supplier details view
  await sendSupplierDetails(ctx, transaction.supplierId, 'all', false); // Sends a new message with updated state
});

// Process Inputs (Add Supplier, Goods & Payments)
suppliersHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step === 'SUPPLIER_ADD') {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return next();

    // Parse phone if provided
    const phoneMatch = rawText.match(/(\+?998\d{9}|\d{9})/);
    const phone = phoneMatch ? phoneMatch[0] : null;
    let name = rawText.replace(/(\+?998\d{9}|\d{9})/, '').trim();
    name = SupplierService.cleanSupplierName(name);

    if (!name || name.length < 2) {
      return ctx.reply("❌ Ta'minotchi nomi kamida 2 ta harfdan iborat bo'lishi kerak. Iltimos qaytadan kiriting:");
    }

    const existing = await prisma.supplier.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' }
      }
    });

    if (existing) {
      if (!existing.isActive) {
        await prisma.supplier.update({
          where: { id: existing.id },
          data: { isActive: true, phone: phone || existing.phone }
        });
        cacheService.invalidateSupplierNames();
        ctx.session.step = undefined;
        ctx.session.tempData = undefined;
        await ctx.reply(`✅ Arxivlangan ta'minotchi (${existing.name}) qayta faollashtirildi!`);
        return sendSupplierDetails(ctx, existing.id, 'all', false);
      }
      ctx.session.step = undefined;
      ctx.session.tempData = undefined;
      await ctx.reply(`⚠️ "${name}" nomli ta'minotchi allaqachon mavjud!`);
      return sendSupplierDetails(ctx, existing.id, 'all', false);
    }

    const newSupplier = await prisma.supplier.create({
      data: {
        name,
        phone,
        debtUzs: 0,
        debtUsd: 0,
        isActive: true
      }
    });

    cacheService.invalidateSupplierNames();
    ctx.session.step = undefined;
    ctx.session.tempData = undefined;

    await ctx.reply(`✅ Yangi ta'minotchi muvaffaqiyatli qo'shildi: *${newSupplier.name}*`, { parse_mode: 'Markdown' });
    return sendSupplierDetails(ctx, newSupplier.id, 'all', false);
  }

  if (ctx.session.step !== 'SUPPLIER_PAYMENT' && ctx.session.step !== 'SUPPLIER_GOODS') return next();

  const rawText = ctx.message.text.trim();
  let cleanNumber = rawText.replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '');
  if (rawText.toLowerCase().includes('ming') || rawText.toLowerCase().includes('k')) {
    cleanNumber = rawText.replace(/\D/g, '') + '000';
  }
  
  const amount = Number(cleanNumber.replace(/\D/g, ''));

  if (!amount || amount <= 0 || isNaN(amount)) {
    return ctx.reply("Iltimos, to'g'ri summa kiriting (masalan: 300000 yoki 300 ming). To'xtatish uchun /start ni bosing.");
  }
  
  if (amount > 10_000_000_000) {
    return ctx.reply("❌ Kiritilgan summa o'ta katta. Iltimos tekshirib qaytadan kiriting (maks: 10 mlrd). To'xtatish uchun /start.");
  }

  const { supplierId, supplierName, action } = ctx.session.tempData;
  const newTx = await prisma.$transaction(async (tx) => {
    // Determine updated debt
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new Error("Not found");
    
    let currentDebt = Number(supplier.debtUzs);
    if (action === 'PAYMENT') currentDebt -= amount;
    else currentDebt += amount;

    let formattedReceipt = `🧾 ELEKTRON NAKLADNOY\n`;
    formattedReceipt += `🏢 Ta'minotchi: ${supplierName}\n`;
    formattedReceipt += `📅 Sana: ${formatDate(new Date())}\n`;
    formattedReceipt += `📥 Kiritish usuli: ✍️ Qo'lda kiritish (Manual)\n`;
    formattedReceipt += `-----------------------------\n`;
    formattedReceipt += `${action === 'PAYMENT' ? "To'lov" : 'Yuk olish'} - ${formatMoney(amount, 'UZS')}\n`;
    formattedReceipt += `-----------------------------\n`;
    formattedReceipt += `💰 Amaliyot summasi: ${formatMoney(amount, 'UZS')}\n`;
    formattedReceipt += `📦 Ushbu amaliyotdan keyingi qarz: ${formatMoney(currentDebt, 'UZS')}\n`;

    // 1. Create Ledger Transaction
    const createdTx = await tx.supplierTransaction.create({
      data: {
        supplierId,
        type: action,
        amount,
        currency: 'UZS',
        sourceType: 'MANUAL',
        formattedReceipt,
        description: action === 'PAYMENT' ? "Qo'lda kiritilgan to'lov" : "Qo'lda kiritilgan kirim (yuk)"
      }
    });

    // 2. Update Balance
    await tx.supplier.update({
      where: { id: supplierId },
      data: { debtUzs: currentDebt }
    });
    
    return createdTx;
  });

  ctx.session.step = undefined;
  ctx.session.tempData = undefined;

  const msgText = action === 'PAYMENT' 
    ? `✅ **${supplierName}** hisobiga **${formatMoney(amount)}** to'lov qo'shildi va qarzdan ayirildi!`
    : `✅ **${supplierName}** dan **${formatMoney(amount)}** lik yuk qabul qilindi va qarzga qo'shildi!`;

  const keyboard = new InlineKeyboard().text("↩️ Bekor qilish (Undo)", `sup:undo:${newTx.id}`);

  await ctx.reply(msgText, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
  
  // Send updated details
  await sendSupplierDetails(ctx, supplierId, 'all', false);
});
