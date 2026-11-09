import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney, formatDate, formatDateShort, formatCompactAmount, parseAmount } from '../../utils/formatters';
import { SupplierService } from '../../services/supplier.service';
import { cacheService } from '../../services/cache.service';
import { addPaginationRow, addTwoColButtons } from '../keyboards/inline';
import { replyOrEdit, clearSession } from '../../utils/telegram';

export const suppliersHandler = new Composer<MyContext>();

async function sendSuppliersPage(ctx: MyContext, page: number, isEdit = false) {
  const PER_PAGE = 10;
  const [totalCount, totalDebtResult] = await Promise.all([
    prisma.supplier.count({ where: { isActive: true } }),
    prisma.supplier.aggregate({ where: { isActive: true }, _sum: { debtUzs: true } })
  ]);
  const totalPages = Math.ceil(totalCount / PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true },
    orderBy: { debtUzs: 'desc' },
    skip: (currentPage - 1) * PER_PAGE,
    take: PER_PAGE,
    select: { id: true, name: true, debtUzs: true }
  });

  const listText = suppliers.length
    ? suppliers.map((sup, idx) => `${(currentPage - 1) * PER_PAGE + idx + 1}. **${sup.name}**: ${formatMoney(sup.debtUzs)}`).join('\n')
    : "Hozircha ta'minotchilar yo'q.";
  const text = `📦 **Ta'minotchilar (Sahifa ${currentPage}/${totalPages})**\nJami qarzimiz: ${formatMoney(totalDebtResult._sum.debtUzs || 0)}\n\n${listText}\n`;

  const kb = new InlineKeyboard();
  addTwoColButtons(kb, suppliers, s => s.name, s => Number(s.debtUzs), s => `sup:v:${s.id}`);
  addPaginationRow(kb, currentPage, totalPages, 'sup:p:');
  kb.text('➕ Yangi', 'sup:add').text('🔙 Asosiy', 'menu:main');
  await replyOrEdit(ctx, text, kb, isEdit);
}

async function sendSupplierDetails(ctx: MyContext, supplierId: string, filter: 'all' | 'month' | 'today', isEdit = false) {
  const now = new Date();
  const startDate = filter === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : filter === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : undefined;

  const [supplier, allIncoming, txStats] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, phone: true, debtUzs: true } }),
    prisma.supplierTransaction.findMany({ where: { supplierId, type: 'INCOMING_GOODS' }, orderBy: { date: 'asc' }, select: { id: true, date: true, amount: true } }),
    prisma.supplierTransaction.groupBy({ by: ['type'], where: startDate ? { supplierId, date: { gte: startDate } } : { supplierId }, _sum: { amount: true } })
  ]);

  if (!supplier) return ctx.callbackQuery ? ctx.answerCallbackQuery("Ta'minotchi topilmadi.") : undefined;

  const totalIncoming = Number(txStats.find(s => s.type === 'INCOMING_GOODS')?._sum.amount || 0);
  const totalPayment = Number(txStats.find(s => s.type === 'PAYMENT')?._sum.amount || 0);
  const bal = Number(supplier.debtUzs);
  const balLine = bal >= 0 ? `💰 **Qarzimiz:** ${formatMoney(bal)}` : `🟢 **Bizning haqimiz:** ${formatMoney(Math.abs(bal))}`;
  const filterText = filter === 'today' ? 'Bugun' : filter === 'month' ? 'Shu oy' : 'Barcha vaqt';
  const text = `🏢 **Ta'minotchi:** ${supplier.name}\n📞 **Tel:** ${supplier.phone || "Yo'q"}\n${balLine}\n\n📊 **Statistika (${filterText}):**\n📥 Kirim: ${formatMoney(totalIncoming)}\n📤 To'lov: ${formatMoney(totalPayment)}\n`;

  const kb = new InlineKeyboard()
    .text(filter === 'today' ? '✅ Bugun' : 'Bugun', `sup:tx:${supplier.id}:today`)
    .text(filter === 'month' ? '✅ Shu oy' : 'Shu oy', `sup:tx:${supplier.id}:month`)
    .text(filter === 'all' ? '✅ Barcha' : 'Barcha', `sup:tx:${supplier.id}:all`)
    .row();

  for (const tx of allIncoming.slice(-3).reverse()) {
    kb.text(`📄 Chek #${allIncoming.findIndex(i => i.id === tx.id) + 1} (${formatDateShort(tx.date)} | ${formatCompactAmount(Number(tx.amount))})`, `sup:receipt:${tx.id}`).row();
  }
  if (allIncoming.length > 3) kb.text(`📂 Barcha cheklar tarixi (Jami: ${allIncoming.length} ta)`, `sup:receipts:list:${supplier.id}:1`).row();

  kb.text('📦 Yuk olish (Kirim)', `sup:goods:${supplier.id}`).text("💸 To'lov qilish", `sup:pay:${supplier.id}`).row()
    .text("🛑 Faoliyatni to'xtatish (Arxivlash)", `sup:archive:${supplier.id}`).row()
    .text("🔙 Ro'yxatga qaytish", 'sup:p:1');

  await replyOrEdit(ctx, text, kb, isEdit);
}

suppliersHandler.hears("📦 Ta'minotchilar", async (ctx) => { if (ctx.user?.role === 'OWNER') await sendSuppliersPage(ctx, 1); });
suppliersHandler.callbackQuery(/^sup:p:(\d+)$/, (ctx) => sendSuppliersPage(ctx, parseInt(ctx.match[1], 10), true));
suppliersHandler.callbackQuery(/^sup:v:(.+)$/, (ctx) => sendSupplierDetails(ctx, ctx.match[1], 'all', true));
suppliersHandler.callbackQuery(/^sup:tx:(.+):(all|month|today)$/, (ctx) => sendSupplierDetails(ctx, ctx.match[1], ctx.match[2] as any, true));

suppliersHandler.callbackQuery(/^sup:archive:(.+)$/, async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return ctx.answerCallbackQuery({ text: "Sizda ushbu amal uchun huquq yo'q!", show_alert: true });
  await prisma.supplier.update({ where: { id: ctx.match[1] }, data: { isActive: false } });
  cacheService.invalidateSupplierNames();
  await ctx.answerCallbackQuery({ text: "Ta'minotchi o'chirildi (Arxivlandi)." });
  await sendSuppliersPage(ctx, 1, true);
});

suppliersHandler.callbackQuery(/^sup:receipts:list:(.+):(\d+)$/, async (ctx) => {
  const [supplierId, rawPage] = [ctx.match[1], parseInt(ctx.match[2], 10) || 1];
  const PER_PAGE = 5;
  const allIncoming = await prisma.supplierTransaction.findMany({ where: { supplierId, type: 'INCOMING_GOODS' }, orderBy: { date: 'asc' }, select: { id: true, date: true, amount: true } });
  const totalPages = Math.ceil(allIncoming.length / PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(rawPage, totalPages));

  const kb = new InlineKeyboard();
  for (const tx of [...allIncoming].reverse().slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE)) {
    kb.text(`📄 Chek #${allIncoming.findIndex(i => i.id === tx.id) + 1} (${formatDateShort(tx.date)} | ${formatCompactAmount(Number(tx.amount))})`, `sup:receipt:${tx.id}`).row();
  }
  addPaginationRow(kb, currentPage, totalPages, `sup:receipts:list:${supplierId}:`);
  kb.text('🔙 Orqaga', `sup:v:${supplierId}`).row();
  await replyOrEdit(ctx, `📂 **Barcha cheklar tarixi (Sahifa ${currentPage}/${totalPages})**\n\nQuyidagi cheklardan birini tanlang:`, kb, true);
});

suppliersHandler.callbackQuery(/^sup:receipt:(.+)$/, async (ctx) => {
  const tx = await prisma.supplierTransaction.findUnique({ where: { id: ctx.match[1] }, include: { supplier: { select: { name: true } } } });
  if (!tx) return ctx.answerCallbackQuery('Ushbu amaliyot topilmadi.');
  const allIncoming = await prisma.supplierTransaction.findMany({ where: { supplierId: tx.supplierId, type: 'INCOMING_GOODS' }, orderBy: { date: 'asc' }, select: { id: true } });
  const checkNo = allIncoming.findIndex(i => i.id === tx.id) + 1;

  const receipt = tx.formattedReceipt
    ? tx.formattedReceipt.replace('🧾 ELEKTRON NAKLADNOY', `🧾 NAKLADNOY CHEK #${checkNo}`)
    : `🧾 NAKLADNOY CHEK #${checkNo}\n🏢 Ta'minotchi: ${tx.supplier.name}\n📅 Sana: ${formatDate(tx.date)}\n💰 Summa: ${formatMoney(tx.amount)}\n${tx.description ? `\nIzoh: ${tx.description}` : ''}`;

  const kb = new InlineKeyboard().text("🔙 Cheklar ro'yxatiga qaytish", `sup:receipts:list:${tx.supplierId}:1`).row();
  if (tx.photoFileId) kb.text("🖼 Asl rasmni ko'rish", `sup:photo:${tx.id}`).row();
  await replyOrEdit(ctx, `\`\`\`\n${receipt}\n\`\`\``, kb, true);
});

suppliersHandler.callbackQuery('close_msg', (ctx) => ctx.deleteMessage().catch(() => { }));

suppliersHandler.callbackQuery(/^sup:photo:(.+)$/, async (ctx) => {
  const tx = await prisma.supplierTransaction.findUnique({ where: { id: ctx.match[1] }, select: { photoFileId: true } });
  if (!tx?.photoFileId) return ctx.answerCallbackQuery("Asl rasm topilmadi yoki o'chirilgan.");
  await ctx.replyWithPhoto(tx.photoFileId, { caption: '🖼 Asl nakladnoy rasmi', reply_markup: new InlineKeyboard().text('🗑 Yopish', 'close_msg') });
});

suppliersHandler.callbackQuery('sup:add', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return ctx.answerCallbackQuery({ text: "Sizda ushbu amal uchun huquq yo'q!", show_alert: true });
  ctx.session.step = 'SUPPLIER_ADD';
  ctx.session.tempData = {};
  await ctx.reply("➕ **Yangi ta'minotchi qo'shish**\n\nTa'minotchi nomi va ixtiyoriy telefon raqamini kiriting:\n(Masalan: `Azamat Shakar +998901234567` yoki shunchaki `Azamat Shakar`)\n\nBekor qilish uchun /start ni bosing.", { parse_mode: 'Markdown' });
});

const startManualSupplierTx = async (ctx: MyContext, supplierId: string, step: 'SUPPLIER_PAYMENT' | 'SUPPLIER_GOODS', action: 'PAYMENT' | 'INCOMING_GOODS', prompt: (name: string) => string) => {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } });
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
  ctx.session.step = step;
  ctx.session.tempData = { supplierId, supplierName: supplier.name, action };
  await ctx.reply(prompt(supplier.name), { parse_mode: 'Markdown' });
};

suppliersHandler.callbackQuery(/^sup:pay:(.+)$/, (ctx) => startManualSupplierTx(ctx, ctx.match[1], 'SUPPLIER_PAYMENT', 'PAYMENT', n => `💸 **${n}** ga to'langan pul summasini raqamlarda kiriting:\n(Masalan: 500000 yoki 500 000)`));
suppliersHandler.callbackQuery(/^sup:goods:(.+)$/, (ctx) => startManualSupplierTx(ctx, ctx.match[1], 'SUPPLIER_GOODS', 'INCOMING_GOODS', n => `📦 **${n}** dan qabul qilingan yuk summasini raqamlarda kiriting:\n(Masalan: 500000 yoki 500 000)`));

suppliersHandler.callbackQuery(/^sup:undo:(.+)$/, async (ctx) => {
  const txId = ctx.match[1];
  const transaction = await prisma.supplierTransaction.findUnique({ where: { id: txId } });
  if (!transaction) return ctx.answerCallbackQuery('Bu amaliyot topilmadi yoki allaqachon bekor qilingan.');
  await prisma.$transaction([
    prisma.supplier.update({ where: { id: transaction.supplierId }, data: { debtUzs: transaction.type === 'INCOMING_GOODS' ? { decrement: transaction.amount } : { increment: transaction.amount } } }),
    prisma.supplierTransaction.delete({ where: { id: txId } })
  ]);
  await ctx.answerCallbackQuery('Amaliyot bekor qilindi va balans tiklandi!');
  await sendSupplierDetails(ctx, transaction.supplierId, 'all', false);
});

suppliersHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step === 'SUPPLIER_ADD') {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return next();
    const phone = rawText.match(/(\+?998\d{9}|\d{9})/)?.[0] || null;
    const name = SupplierService.cleanSupplierName(rawText.replace(/(\+?998\d{9}|\d{9})/, '').trim());
    if (!name || name.length < 2) return ctx.reply("❌ Ta'minotchi nomi kamida 2 ta harfdan iborat bo'lishi kerak. Iltimos qaytadan kiriting:");

    const existing = await prisma.supplier.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    clearSession(ctx);

    if (existing) {
      if (!existing.isActive) {
        await prisma.supplier.update({ where: { id: existing.id }, data: { isActive: true, phone: phone || existing.phone } });
        cacheService.invalidateSupplierNames();
        await ctx.reply(`✅ Arxivlangan ta'minotchi (${existing.name}) qayta faollashtirildi!`);
      } else {
        await ctx.reply(`⚠️ "${name}" nomli ta'minotchi allaqachon mavjud!`);
      }
      return sendSupplierDetails(ctx, existing.id, 'all', false);
    }

    const newSupplier = await prisma.supplier.create({ data: { name, phone, debtUzs: 0, debtUsd: 0, isActive: true } });
    cacheService.invalidateSupplierNames();
    await ctx.reply(`✅ Yangi ta'minotchi muvaffaqiyatli qo'shildi: *${newSupplier.name}*`, { parse_mode: 'Markdown' });
    return sendSupplierDetails(ctx, newSupplier.id, 'all', false);
  }

  if (ctx.session.step !== 'SUPPLIER_PAYMENT' && ctx.session.step !== 'SUPPLIER_GOODS') return next();
  const amount = parseAmount(ctx.message.text.trim());
  if (!amount || amount <= 0 || isNaN(amount)) return ctx.reply("Iltimos, to'g'ri summa kiriting (masalan: 300000 yoki 300 ming). To'xtatish uchun /start ni bosing.");
  if (amount > 10_000_000_000) return ctx.reply("❌ Kiritilgan summa o'ta katta. Iltimos tekshirib qaytadan kiriting (maks: 10 mlrd). To'xtatish uchun /start.");

  const { supplierId, supplierName, action } = ctx.session.tempData;
  const isPay = action === 'PAYMENT';

  const { createdTx, currentDebt } = await prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { debtUzs: true } });
    if (!supplier) throw new Error('Not found');
    const currentDebt = Number(supplier.debtUzs) + (isPay ? -amount : amount);
    const formattedReceipt = `🧾 ELEKTRON NAKLADNOY\n🏢 Ta'minotchi: ${supplierName}\n📅 Sana: ${formatDate(new Date())}\n📥 Kiritish usuli: ✍️ Qo'lda kiritish (Manual)\n-----------------------------\n${isPay ? "To'lov" : 'Yuk olish'} - ${formatMoney(amount, 'UZS')}\n-----------------------------\n💰 Amaliyot summasi: ${formatMoney(amount, 'UZS')}\n📦 Ushbu amaliyotdan keyingi qarz: ${formatMoney(currentDebt, 'UZS')}\n`;
    const [createdTx] = await Promise.all([
      tx.supplierTransaction.create({
        data: { supplierId, type: action, amount, currency: 'UZS', sourceType: 'MANUAL', formattedReceipt, description: isPay ? "Qo'lda kiritilgan to'lov" : "Qo'lda kiritilgan kirim (yuk)" }
      }),
      tx.supplier.update({ where: { id: supplierId }, data: { debtUzs: currentDebt } })
    ]);
    return { createdTx, currentDebt };
  });

  clearSession(ctx);
  const msgText = isPay
    ? `✅ **${supplierName}** hisobiga **${formatMoney(amount)}** to'lov kiritildi va qarzdan ayirildi!\n📊 **Yakuniy qarz qoldig'i:** **${formatMoney(currentDebt)}**`
    : `✅ **${supplierName}** dan **${formatMoney(amount)}** lik yuk qabul qilindi va qarzga qo'shildi!\n📊 **Yakuniy qarz qoldig'i:** **${formatMoney(currentDebt)}**`;
  await ctx.reply(msgText, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('↩️ Bekor qilish (Undo)', `sup:undo:${createdTx.id}`) });
  await sendSupplierDetails(ctx, supplierId, 'all', false);
});
