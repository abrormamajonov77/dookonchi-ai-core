import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import {
  formatCurrency,
  formatDate,
  formatDateShort,
  formatCompactAmount,
  formatSom,
  formatUsd,
  parseCurrencyAndAmount,
} from '../../utils/formatters';
import { SupplierService } from '../../services/supplier.service';
import { cacheService } from '../../services/cache.service';
import { addPaginationRow, addTwoColButtons, getSavedInvoiceCardKeyboard } from '../keyboards/inline';
import { replyOrEdit, clearSession } from '../../utils/telegram';

export const suppliersHandler = new Composer<MyContext>();

async function sendSuppliersPage(ctx: MyContext, page: number, isEdit = false) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const report = await SupplierService.getFormattedDebtorsReport(page, 10, ownerId);

  const kb = new InlineKeyboard();
  addTwoColButtons(
    kb,
    report.suppliers,
    (s) => s.name,
    (s) => Number(s.debtUzs) || Number(s.debtUsd),
    (s) => `sup:v:${s.id}`
  );
  addPaginationRow(kb, report.currentPage, report.totalPages, 'sup:p:');
  kb.text('➕ Yangi', 'sup:add').text('🔙 Asosiy', 'menu:main');
  await replyOrEdit(ctx, report.text, kb, isEdit);
}

export async function sendSupplierDetails(
  ctx: MyContext,
  supplierId: string,
  filter: 'all' | 'month' | 'today' = 'all',
  isEdit = false
) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const now = new Date();
  const startDate =
    filter === 'today'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : filter === 'month'
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : undefined;

  const [supplier, allIncoming, txStats] = await Promise.all([
    prisma.supplier.findFirst({
      where: { id: supplierId, ownerId },
      select: { id: true, name: true, phone: true, debtUzs: true, debtUsd: true },
    }),
    prisma.supplierTransaction.findMany({
      where: { ownerId, supplierId, type: 'INCOMING_GOODS' },
      orderBy: { date: 'asc' },
      select: { id: true, invoiceId: true, date: true, amount: true, currency: true },
    }),
    prisma.supplierTransaction.groupBy({
      by: ['type', 'currency'],
      where: startDate ? { ownerId, supplierId, date: { gte: startDate } } : { ownerId, supplierId },
      _sum: { amount: true },
    }),
  ]);

  if (!supplier) return ctx.callbackQuery ? ctx.answerCallbackQuery("Ta'minotchi topilmadi.") : undefined;

  const incUzs = Number(
    txStats.find((s) => s.type === 'INCOMING_GOODS' && s.currency === 'UZS')?._sum.amount || 0
  );
  const incUsd = Number(
    txStats.find((s) => s.type === 'INCOMING_GOODS' && s.currency === 'USD')?._sum.amount || 0
  );
  const payUzs = Number(txStats.find((s) => s.type === 'PAYMENT' && s.currency === 'UZS')?._sum.amount || 0);
  const payUsd = Number(txStats.find((s) => s.type === 'PAYMENT' && s.currency === 'USD')?._sum.amount || 0);

  const balUzs = Number(supplier.debtUzs);
  const balUsd = Number(supplier.debtUsd);

  const uzsLine =
    balUzs >= 0
      ? `💰 **Qarzimiz (UZS):** ${formatSom(balUzs)}`
      : `🟢 **Haqimiz (UZS):** ${formatSom(Math.abs(balUzs))}`;
  const usdLine =
    balUsd >= 0
      ? `💵 **Qarzimiz (USD/USDT):** ${formatUsd(balUsd, true)}`
      : `🟢 **Haqimiz (USD/USDT):** ${formatUsd(Math.abs(balUsd), true)}`;

  const filterText = filter === 'today' ? 'Bugun' : filter === 'month' ? 'Shu oy' : 'Barcha vaqt';
  const incText = incUsd > 0 ? `${formatSom(incUzs)} | 💵 ${formatUsd(incUsd)}` : formatSom(incUzs);
  const payText = payUsd > 0 ? `${formatSom(payUzs)} | 💵 ${formatUsd(payUsd)}` : formatSom(payUzs);

  const text =
    `🏢 **Ta'minotchi:** ${supplier.name}\n` +
    `📞 **Tel:** ${supplier.phone || "Yo'q"}\n` +
    `${uzsLine}\n` +
    `${usdLine}\n\n` +
    `📊 **Statistika (${filterText}):**\n` +
    `📥 Kirim: ${incText}\n` +
    `📤 To'lov: ${payText}\n`;

  const kb = new InlineKeyboard()
    .text(filter === 'today' ? '✅ Bugun' : 'Bugun', `sup:tx:${supplier.id}:today`)
    .text(filter === 'month' ? '✅ Shu oy' : 'Shu oy', `sup:tx:${supplier.id}:month`)
    .text(filter === 'all' ? '✅ Barcha' : 'Barcha', `sup:tx:${supplier.id}:all`)
    .row();

  for (const tx of allIncoming.slice(-3).reverse()) {
    const checkIdx = allIncoming.findIndex((i) => i.id === tx.id) + 1;
    kb.text(
      `📄 Chek #${checkIdx} (${formatDateShort(tx.date)} | ${formatCompactAmount(Number(tx.amount), tx.currency)})`,
      `sup:receipt:${tx.id}`
    ).row();
  }
  if (allIncoming.length > 3) {
    kb.text(`📂 Barcha cheklar tarixi (Jami: ${allIncoming.length} ta)`, `sup:receipts:list:${supplier.id}:1`).row();
  }

  kb.text('📦 Yuk olish (Kirim)', `sup:goods:${supplier.id}`)
    .text("💸 To'lov qilish", `sup:pay:${supplier.id}`)
    .row()
    .text("✏️ Nomini o'zgartirish", `edit_supplier_name:${supplier.id}`)
    .row()
    .text("🛑 Faoliyatni to'xtatish (Arxivlash)", `sup:archive:${supplier.id}`)
    .row()
    .text("🔙 Ro'yxatga qaytish", 'sup:p:1');

  await replyOrEdit(ctx, text, kb, isEdit);
}

suppliersHandler.hears("📦 Ta'minotchilar", async (ctx) => {
  await sendSuppliersPage(ctx, 1);
});
suppliersHandler.callbackQuery(/^sup:p:(\d+)$/, (ctx) =>
  sendSuppliersPage(ctx, parseInt(ctx.match[1], 10), true)
);
suppliersHandler.callbackQuery(/^sup:v:(.+)$/, (ctx) =>
  sendSupplierDetails(ctx, ctx.match[1], 'all', true)
);
suppliersHandler.callbackQuery(/^sup:tx:(.+):(all|month|today)$/, (ctx) =>
  sendSupplierDetails(ctx, ctx.match[1], ctx.match[2] as any, true)
);

suppliersHandler.callbackQuery(/^edit_supplier_name:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const supplierId = ctx.match[1];
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, ownerId },
    select: { id: true, name: true },
  });
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  ctx.session.step = 'AWAITING_SUPPLIER_NEW_NAME';
  ctx.session.tempData = { supplierId: supplier.id, oldName: supplier.name };

  const kb = new InlineKeyboard().text('❌ Bekor qilish', `cancel_edit_supplier_name:${supplier.id}`);
  await ctx.reply(
    `✏️ **"${supplier.name}"** ta'minotchisining yangi nomini yozib yuboring:`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

suppliersHandler.callbackQuery(/^cancel_edit_supplier_name:(.+)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  clearSession(ctx);
  await sendSupplierDetails(ctx, supplierId, 'all', true);
});

suppliersHandler.callbackQuery(/^confirm_merge_supplier:([^:]+):([^:]+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const [, sourceId, targetId] = ctx.match;
  try {
    const merged = await SupplierService.mergeSuppliers(sourceId, targetId, ownerId);
    clearSession(ctx);
    await ctx.answerCallbackQuery({ text: "✅ Ta'minotchilar muvaffaqiyatli birlashtirildi!" });
    await ctx.editMessageText(
      `✅ Ta'minotchilar **"${merged.name}"** hisobiga muvaffaqiyatli birlashtirildi!\n\n` +
        `💰 Jami qarz (UZS): **${formatSom(merged.debtUzs)}**\n` +
        `💵 Jami qarz (USD/USDT): **${formatUsd(merged.debtUsd)}**`,
      { parse_mode: 'Markdown' }
    );
    await sendSupplierDetails(ctx, merged.id, 'all', false);
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
  }
});

suppliersHandler.callbackQuery(/^cancel_merge_supplier:(.+)$/, async (ctx) => {
  const supplierId = ctx.match[1];
  clearSession(ctx);
  await ctx.editMessageText('❌ Birlashtirish bekor qilindi.');
  await sendSupplierDetails(ctx, supplierId, 'all', false);
});

suppliersHandler.callbackQuery(/^sup:archive:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  await prisma.supplier.updateMany({ where: { id: ctx.match[1], ownerId }, data: { isActive: false } });
  cacheService.invalidateSupplierNames(ownerId);
  await ctx.answerCallbackQuery({ text: "Ta'minotchi o'chirildi (Arxivlandi)." });
  await sendSuppliersPage(ctx, 1, true);
});

suppliersHandler.callbackQuery(/^sup:receipts:list:(.+):(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const [supplierId, rawPage] = [ctx.match[1], parseInt(ctx.match[2], 10) || 1];
  const PER_PAGE = 5;
  const allIncoming = await prisma.supplierTransaction.findMany({
    where: { ownerId, supplierId, type: 'INCOMING_GOODS' },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, amount: true, currency: true },
  });
  const totalPages = Math.ceil(allIncoming.length / PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(rawPage, totalPages));

  const kb = new InlineKeyboard();
  for (const tx of [...allIncoming].reverse().slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE)) {
    kb.text(
      `📄 Chek #${allIncoming.findIndex((i) => i.id === tx.id) + 1} (${formatDateShort(tx.date)} | ${formatCompactAmount(Number(tx.amount), tx.currency)})`,
      `sup:receipt:${tx.id}`
    ).row();
  }
  addPaginationRow(kb, currentPage, totalPages, `sup:receipts:list:${supplierId}:`);
  kb.text('🔙 Orqaga', `sup:v:${supplierId}`).row();
  await replyOrEdit(
    ctx,
    `📂 **Barcha cheklar tarixi (Sahifa ${currentPage}/${totalPages})**\n\nQuyidagi cheklardan birini tanlang:`,
    kb,
    true
  );
});

suppliersHandler.callbackQuery(/^sup:receipt:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const tx = await prisma.supplierTransaction.findFirst({
    where: { id: ctx.match[1], ownerId },
    include: { supplier: { select: { name: true } } },
  });
  if (!tx) return ctx.answerCallbackQuery('Ushbu amaliyot topilmadi.');
  const allIncoming = await prisma.supplierTransaction.findMany({
    where: { ownerId, supplierId: tx.supplierId, type: 'INCOMING_GOODS' },
    orderBy: { date: 'asc' },
    select: { id: true },
  });
  const checkNo = allIncoming.findIndex((i) => i.id === tx.id) + 1;

  const receipt = tx.formattedReceipt
    ? tx.formattedReceipt.replace('🧾 ELEKTRON NAKLADNOY', `🧾 NAKLADNOY CHEK #${checkNo}`)
    : `🧾 NAKLADNOY CHEK #${checkNo}\n🏢 Ta'minotchi: ${tx.supplier.name}\n📅 Sana: ${formatDate(tx.date)}\n💰 Summa: ${formatCurrency(tx.amount, tx.currency)}\n${tx.description ? `\nIzoh: ${tx.description}` : ''}`;

  const targetInvoiceId = tx.invoiceId || (tx.receiptData as any)?.invoiceId || tx.id;
  const kb = getSavedInvoiceCardKeyboard(targetInvoiceId, tx.supplierId, tx.photoFileId, tx.id);
  await replyOrEdit(ctx, `\`\`\`\n${receipt}\n\`\`\``, kb, true);
});

suppliersHandler.callbackQuery('close_msg', (ctx) => ctx.deleteMessage().catch(() => {}));

suppliersHandler.callbackQuery(/^sup:photo:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const tx = await prisma.supplierTransaction.findFirst({
    where: { id: ctx.match[1], ownerId },
    select: { photoFileId: true },
  });
  if (!tx?.photoFileId) return ctx.answerCallbackQuery("Asl rasm topilmadi yoki o'chirilgan.");
  await ctx.replyWithPhoto(tx.photoFileId, {
    caption: '🖼 Asl nakladnoy rasmi',
    reply_markup: new InlineKeyboard().text('🗑 Yopish', 'close_msg'),
  });
});

suppliersHandler.callbackQuery('sup:add', async (ctx) => {
  ctx.session.step = 'SUPPLIER_ADD';
  ctx.session.tempData = {};
  await ctx.reply(
    "➕ **Yangi ta'minotchi qo'shish**\n\nTa'minotchi nomi va ixtiyoriy telefon raqamini kiriting:\n(Masalan: `Azamat Shakar +998901234567` yoki shunchaki `Azamat Shakar`)\n\nBekor qilish uchun /start ni bosing.",
    { parse_mode: 'Markdown' }
  );
});

const getCurrencySelectKeyboard = (selectedCurrency: 'UZS' | 'USD' = 'UZS') =>
  new InlineKeyboard()
    .text(
      selectedCurrency === 'UZS' ? "✅ 🇺🇿 So'mda (UZS)" : "🇺🇿 So'mda (UZS)",
      'sup:set_cur:UZS'
    )
    .text(
      selectedCurrency === 'USD' ? '✅ 💵 Dollarda (USD/USDT)' : '💵 Dollarda (USD/USDT)',
      'sup:set_cur:USD'
    );

const startManualSupplierTx = async (
  ctx: MyContext,
  supplierId: string,
  step: 'SUPPLIER_PAYMENT' | 'SUPPLIER_GOODS',
  action: 'PAYMENT' | 'INCOMING_GOODS',
  prompt: (name: string) => string
) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, ownerId },
    select: { name: true },
  });
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
  ctx.session.step = step;
  ctx.session.tempData = { supplierId, supplierName: supplier.name, action, currency: 'UZS' as const };
  await ctx.reply(prompt(supplier.name), {
    parse_mode: 'Markdown',
    reply_markup: getCurrencySelectKeyboard('UZS'),
  });
};

suppliersHandler.callbackQuery(/^sup:set_cur:(UZS|USD)$/, async (ctx) => {
  const selected = ctx.match[1] as 'UZS' | 'USD';
  if (ctx.session.tempData) {
    ctx.session.tempData.currency = selected;
  }
  await ctx.answerCallbackQuery({
    text: selected === 'USD' ? "💵 Valyuta: USD ($) tanlandi" : "🇺🇿 Valyuta: So'm (UZS) tanlandi",
  });
  if (ctx.callbackQuery.message) {
    await ctx.editMessageReplyMarkup({ reply_markup: getCurrencySelectKeyboard(selected) }).catch(() => {});
  }
});

suppliersHandler.callbackQuery(/^sup:pay:(.+)$/, (ctx) =>
  startManualSupplierTx(
    ctx,
    ctx.match[1],
    'SUPPLIER_PAYMENT',
    'PAYMENT',
    (n) =>
      `💸 **${n}** ga to'langan pul summasini kiriting:\n` +
      `• So'mda: masalan \`500000\` yoki \`500 ming\`\n` +
      `• Dollarda: masalan \`$50\`, \`50 USDT\` yoki \`50.17$\`\n\n` +
      `Pastdagi tugma orqali valyutani tanlashingiz ham mumkin:`
  )
);

suppliersHandler.callbackQuery(/^sup:goods:(.+)$/, (ctx) =>
  startManualSupplierTx(
    ctx,
    ctx.match[1],
    'SUPPLIER_GOODS',
    'INCOMING_GOODS',
    (n) =>
      `📦 **${n}** dan qabul qilingan yuk summasini kiriting:\n` +
      `• So'mda: masalan \`500000\` yoki \`500 ming\`\n` +
      `• Dollarda: masalan \`$102.17\`, \`102,17 USDT\` yoki \`102 dollar 17 sent\``
  )
);

suppliersHandler.callbackQuery(/^sup:undo:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const txId = ctx.match[1];
  const transaction = await prisma.supplierTransaction.findFirst({ where: { id: txId, ownerId } });
  if (!transaction)
    return ctx.answerCallbackQuery('Bu amaliyot topilmadi yoki allaqachon bekor qilingan.');

  const isUsd = transaction.currency === 'USD';
  const isIncoming = transaction.type === 'INCOMING_GOODS';

  await prisma.$transaction([
    prisma.supplier.update({
      where: { id: transaction.supplierId },
      data: isUsd
        ? { debtUsd: isIncoming ? { decrement: transaction.amount } : { increment: transaction.amount } }
        : { debtUzs: isIncoming ? { decrement: transaction.amount } : { increment: transaction.amount } },
    }),
    prisma.supplierTransaction.delete({ where: { id: txId } }),
  ]);
  await ctx.answerCallbackQuery('Amaliyot bekor qilindi va balans tiklandi!');
  await sendSupplierDetails(ctx, transaction.supplierId, 'all', false);
});

suppliersHandler.on('message:text', async (ctx, next) => {
  if (!ctx.from) return next();
  const ownerId = String(ctx.from.id);

  if (ctx.session.step === 'AWAITING_SUPPLIER_NEW_NAME') {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return next();
    const { supplierId } = ctx.session.tempData || {};
    if (!supplierId) {
      clearSession(ctx);
      return next();
    }

    try {
      const checkResult = await SupplierService.checkOrRenameSupplier(supplierId, rawText, ownerId);
      if (checkResult.status === 'MERGE_REQUIRED') {
        clearSession(ctx);
        const kb = new InlineKeyboard()
          .text(
            '✅ Ha, birlashtir',
            `confirm_merge_supplier:${checkResult.sourceSupplier.id}:${checkResult.targetSupplier.id}`
          )
          .text("❌ Yo'q", `cancel_merge_supplier:${checkResult.sourceSupplier.id}`);
        return ctx.reply(
          `⚠️ '${checkResult.targetSupplier.name}' nomli ta'minotchi bazada bor. Ikkalasini birlashtirib, barcha nakladnoy va qarzlarni (UZS va USD) bitta hisobga o'tkazaymi?`,
          { reply_markup: kb }
        );
      }

      clearSession(ctx);
      await ctx.reply(
        `✅ Ta'minotchi nomi **"${checkResult.supplier.name}"** ga o'zgartirildi! Barcha nakladnoy va to'lovlar tarixi to'liq saqlandi.`,
        { parse_mode: 'Markdown' }
      );
      return sendSupplierDetails(ctx, checkResult.supplier.id, 'all', false);
    } catch (err: any) {
      return ctx.reply(`❌ ${err?.message || 'Xatolik yuz berdi. Qaytadan kiriting:'}`);
    }
  }

  if (ctx.session.step === 'SUPPLIER_ADD') {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return next();
    const phone = rawText.match(/(\+?998\d{9}|\d{9})/)?.[0] || null;
    const name = SupplierService.cleanSupplierName(rawText.replace(/(\+?998\d{9}|\d{9})/, '').trim());
    if (!name || name.length < 2)
      return ctx.reply(
        "❌ Ta'minotchi nomi kamida 2 ta harfdan iborat bo'lishi kerak. Iltimos qaytadan kiriting:"
      );

    const existing = await prisma.supplier.findFirst({
      where: { ownerId, name: { equals: name, mode: 'insensitive' } },
    });
    clearSession(ctx);

    if (existing) {
      if (!existing.isActive) {
        await prisma.supplier.update({
          where: { id: existing.id },
          data: { isActive: true, phone: phone || existing.phone },
        });
        cacheService.invalidateSupplierNames(ownerId);
        await ctx.reply(`✅ Arxivlangan ta'minotchi (${existing.name}) qayta faollashtirildi!`);
      } else {
        await ctx.reply(`⚠️ "${name}" nomli ta'minotchi allaqachon mavjud!`);
      }
      return sendSupplierDetails(ctx, existing.id, 'all', false);
    }

    const newSupplier = await prisma.supplier.create({
      data: { ownerId, name, phone, debtUzs: 0, debtUsd: 0, isActive: true },
    });
    cacheService.invalidateSupplierNames(ownerId);
    await ctx.reply(`✅ Yangi ta'minotchi muvaffaqiyatli qo'shildi: *${newSupplier.name}*`, {
      parse_mode: 'Markdown',
    });
    return sendSupplierDetails(ctx, newSupplier.id, 'all', false);
  }

  if (ctx.session.step !== 'SUPPLIER_PAYMENT' && ctx.session.step !== 'SUPPLIER_GOODS') return next();

  const rawText = ctx.message.text.trim();
  if (rawText.startsWith('/')) return next();

  const parsed = parseCurrencyAndAmount(rawText);
  const amount = parsed.amount;
  const currency: 'UZS' | 'USD' =
    parsed.currency === 'USD' ? 'USD' : ctx.session.tempData?.currency === 'USD' ? 'USD' : 'UZS';

  if (!amount || amount <= 0 || isNaN(amount))
    return ctx.reply(
      "Iltimos, to'g'ri summa kiriting (masalan: 300000, 300 ming yoki $50.17). To'xtatish uchun /start ni bosing."
    );
  if (amount > 10_000_000_000)
    return ctx.reply(
      "❌ Kiritilgan summa o'ta katta. Iltimos tekshirib qaytadan kiriting (maks: 10 mlrd). To'xtatish uchun /start."
    );

  const { supplierId, supplierName, action } = ctx.session.tempData;
  const isPay = action === 'PAYMENT';
  const isUsd = currency === 'USD';

  const { createdTx, currentDebt } = await prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({
      where: { id: supplierId, ownerId },
      select: { debtUzs: true, debtUsd: true },
    });
    if (!supplier) throw new Error('Not found');

    const prevDebt = Number(isUsd ? supplier.debtUsd : supplier.debtUzs);
    const currentDebt = Number((prevDebt + (isPay ? -amount : amount)).toFixed(2));
    const formattedAmt = formatCurrency(amount, currency);
    const formattedPostDebt = formatCurrency(currentDebt, currency);

    const formattedReceipt =
      `🧾 ELEKTRON NAKLADNOY\n` +
      `🏢 Ta'minotchi: ${supplierName}\n` +
      `📅 Sana: ${formatDate(new Date())}\n` +
      `📥 Kiritish usuli: ✍️ Qo'lda kiritish (Manual)\n` +
      `-----------------------------\n` +
      `${isPay ? "To'lov" : 'Yuk olish'} - ${formattedAmt}\n` +
      `-----------------------------\n` +
      `💰 Amaliyot summasi: ${formattedAmt}\n` +
      `📦 Ushbu amaliyotdan keyingi qarz: ${formattedPostDebt}\n`;

    const [createdTx] = await Promise.all([
      tx.supplierTransaction.create({
        data: {
          ownerId,
          supplierId,
          type: action,
          amount,
          currency,
          sourceType: 'MANUAL',
          formattedReceipt,
          description: isPay ? "Qo'lda kiritilgan to'lov" : "Qo'lda kiritilgan kirim (yuk)",
        },
      }),
      isPay
        ? tx.supplierPayment.create({
            data: { ownerId, supplierId, amount, currency, comment: "Qo'lda kiritilgan to'lov" },
          })
        : Promise.resolve(null),
      tx.supplier.update({
        where: { id: supplierId },
        data: isUsd ? { debtUsd: currentDebt } : { debtUzs: currentDebt },
      }),
    ]);
    return { createdTx, currentDebt };
  });

  clearSession(ctx);
  const formattedAmt = formatCurrency(amount, currency);
  const formattedPostDebt = formatCurrency(currentDebt, currency);

  const msgText = isPay
    ? `✅ **${supplierName}** hisobiga **${formattedAmt}** to'lov kiritildi va ${isUsd ? 'USD' : 'UZS'} qarzdan ayirildi!\n📊 **Yakuniy qarz qoldig'i (${currency}):** **${formattedPostDebt}**`
    : `✅ **${supplierName}** dan **${formattedAmt}** lik yuk qabul qilindi va ${isUsd ? 'USD' : 'UZS'} qarzga qo'shildi!\n📊 **Yakuniy qarz qoldig'i (${currency}):** **${formattedPostDebt}**`;

  await ctx.reply(msgText, {
    parse_mode: 'Markdown',
    reply_markup: new InlineKeyboard().text('↩️ Bekor qilish (Undo)', `sup:undo:${createdTx.id}`),
  });
  await sendSupplierDetails(ctx, supplierId, 'all', false);
});
