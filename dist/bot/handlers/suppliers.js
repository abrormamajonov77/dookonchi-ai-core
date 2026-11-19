"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suppliersHandler = void 0;
exports.sendSupplierDetails = sendSupplierDetails;
exports.handleSupplierPayment = handleSupplierPayment;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const formatters_1 = require("../../utils/formatters");
const supplier_service_1 = require("../../services/supplier.service");
const cache_service_1 = require("../../services/cache.service");
const inline_1 = require("../keyboards/inline");
const telegram_1 = require("../../utils/telegram");
const menu_1 = require("../keyboards/menu");
const transliterate_1 = require("../../utils/transliterate");
exports.suppliersHandler = new grammy_1.Composer();
async function sendSuppliersPage(ctx, page, isEdit = false) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const report = await supplier_service_1.SupplierService.getFormattedDebtorsReport(page, 10, ownerId);
    const kb = new grammy_1.InlineKeyboard();
    (0, inline_1.addTwoColButtons)(kb, report.suppliers, (s) => (0, transliterate_1.toLatinUz)(s.name), (s) => Number(s.debtUzs) || Number(s.debtUsd), (s) => `sup:v:${s.id}`);
    (0, inline_1.addPaginationRow)(kb, report.currentPage, report.totalPages, 'sup:p:');
    kb.text('➕ Yangi', 'sup:add').text('🔙 Asosiy', 'menu:main');
    await (0, telegram_1.replyOrEdit)(ctx, report.text, kb, isEdit);
}
async function sendSupplierDetails(ctx, supplierId, filter = 'all', isEdit = false) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const now = new Date();
    const startDate = filter === 'today'
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : filter === 'month'
            ? new Date(now.getFullYear(), now.getMonth(), 1)
            : undefined;
    const [supplier, allIncoming, txStats] = await Promise.all([
        prisma_1.prisma.supplier.findFirst({
            where: { id: supplierId, ownerId },
            select: { id: true, name: true, phone: true, debtUzs: true, debtUsd: true },
        }),
        prisma_1.prisma.supplierTransaction.findMany({
            where: { ownerId, supplierId, type: 'INCOMING_GOODS' },
            orderBy: { date: 'asc' },
            select: { id: true, invoiceId: true, date: true, amount: true, currency: true },
        }),
        prisma_1.prisma.supplierTransaction.groupBy({
            by: ['type', 'currency'],
            where: startDate ? { ownerId, supplierId, date: { gte: startDate } } : { ownerId, supplierId },
            _sum: { amount: true },
        }),
    ]);
    if (!supplier)
        return ctx.callbackQuery ? ctx.answerCallbackQuery("Ta'minotchi topilmadi.") : undefined;
    const incUzs = Number(txStats.find((s) => s.type === 'INCOMING_GOODS' && s.currency === 'UZS')?._sum.amount || 0);
    const incUsd = Number(txStats.find((s) => s.type === 'INCOMING_GOODS' && s.currency === 'USD')?._sum.amount || 0);
    const payUzs = Number(txStats.find((s) => s.type === 'PAYMENT' && s.currency === 'UZS')?._sum.amount || 0);
    const payUsd = Number(txStats.find((s) => s.type === 'PAYMENT' && s.currency === 'USD')?._sum.amount || 0);
    const balUzs = Number(supplier.debtUzs);
    const balUsd = Number(supplier.debtUsd);
    const uzsLine = balUzs >= 0
        ? `💰 **Qarzimiz (UZS):** ${(0, formatters_1.formatSom)(balUzs)}`
        : `🟢 **Haqimiz (UZS):** ${(0, formatters_1.formatSom)(Math.abs(balUzs))}`;
    const usdLine = balUsd >= 0
        ? `💵 **Qarzimiz (USD/USDT):** ${(0, formatters_1.formatUsd)(balUsd, true)}`
        : `🟢 **Haqimiz (USD/USDT):** ${(0, formatters_1.formatUsd)(Math.abs(balUsd), true)}`;
    const filterText = filter === 'today' ? 'Bugun' : filter === 'month' ? 'Shu oy' : 'Barcha vaqt';
    const incText = incUsd > 0 ? `${(0, formatters_1.formatSom)(incUzs)} | 💵 ${(0, formatters_1.formatUsd)(incUsd)}` : (0, formatters_1.formatSom)(incUzs);
    const payText = payUsd > 0 ? `${(0, formatters_1.formatSom)(payUzs)} | 💵 ${(0, formatters_1.formatUsd)(payUsd)}` : (0, formatters_1.formatSom)(payUzs);
    const text = `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(supplier.name))}\n` +
        `📞 **Tel:** ${(0, telegram_1.sanitizeMdV1)(supplier.phone || "Yo'q")}\n` +
        `${uzsLine}\n` +
        `${usdLine}\n\n` +
        `📊 **Statistika (${filterText}):**\n` +
        `📥 Kirim: ${incText}\n` +
        `📤 To'lov: ${payText}\n`;
    const kb = new grammy_1.InlineKeyboard()
        .text(filter === 'today' ? '✅ Bugun' : 'Bugun', `sup:tx:${supplier.id}:today`)
        .text(filter === 'month' ? '✅ Shu oy' : 'Shu oy', `sup:tx:${supplier.id}:month`)
        .text(filter === 'all' ? '✅ Barcha' : 'Barcha', `sup:tx:${supplier.id}:all`)
        .row();
    for (const tx of allIncoming.slice(-3).reverse()) {
        const checkIdx = allIncoming.findIndex((i) => i.id === tx.id) + 1;
        kb.text(`📄 Chek #${checkIdx} (${(0, formatters_1.formatDateShort)(tx.date)} | ${(0, formatters_1.formatCompactAmount)(Number(tx.amount), tx.currency)})`, `sup:receipt:${tx.id}`).row();
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
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
exports.suppliersHandler.hears("📦 Ta'minotchilar", async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await sendSuppliersPage(ctx, 1);
});
exports.suppliersHandler.callbackQuery(/^sup:p:(\d+)$/, (ctx) => sendSuppliersPage(ctx, parseInt(ctx.match[1], 10), true));
exports.suppliersHandler.callbackQuery(/^sup:v:(.+)$/, (ctx) => sendSupplierDetails(ctx, ctx.match[1], 'all', true));
exports.suppliersHandler.callbackQuery(/^sup:tx:(.+):(all|month|today)$/, (ctx) => sendSupplierDetails(ctx, ctx.match[1], ctx.match[2], true));
exports.suppliersHandler.callbackQuery(/^edit_supplier_name:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const supplierId = ctx.match[1];
    const supplier = await prisma_1.prisma.supplier.findFirst({
        where: { id: supplierId, ownerId },
        select: { id: true, name: true },
    });
    if (!supplier)
        return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
    ctx.session.step = 'AWAITING_SUPPLIER_NEW_NAME';
    ctx.session.tempData = { supplierId: supplier.id, oldName: supplier.name };
    const kb = new grammy_1.InlineKeyboard().text('❌ Bekor qilish', `cancel_edit_supplier_name:${supplier.id}`);
    await (0, telegram_1.safeReply)(ctx, `✏️ **"${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(supplier.name))}"** ta'minotchisining yangi nomini yozib yuboring:`, { parse_mode: 'Markdown', reply_markup: kb });
});
exports.suppliersHandler.callbackQuery(/^cancel_edit_supplier_name:(.+)$/, async (ctx) => {
    const supplierId = ctx.match[1];
    (0, telegram_1.clearSession)(ctx);
    await sendSupplierDetails(ctx, supplierId, 'all', true);
});
async function executeSupplierMerge(ctx, sourceId, targetId, ownerId) {
    const merged = await supplier_service_1.SupplierService.mergeSuppliers(sourceId, targetId, ownerId);
    (0, telegram_1.clearSession)(ctx);
    await ctx.answerCallbackQuery({ text: "✅ Ta'minotchilar muvaffaqiyatli birlashtirildi!" });
    if (ctx.callbackQuery?.message && ctx.chat?.id) {
        await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, `✅ Ta'minotchilar **"${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(merged.name))}"** hisobiga muvaffaqiyatli birlashtirildi!\n\n` +
            `💰 Jami qarz (UZS): **${(0, formatters_1.formatSom)(merged.debtUzs)}**\n` +
            `💵 Jami qarz (USD/USDT): **${(0, formatters_1.formatUsd)(merged.debtUsd)}**`, { parse_mode: 'Markdown' }).catch(() => { });
    }
    await sendSupplierDetails(ctx, merged.id, 'all', false);
}
exports.suppliersHandler.callbackQuery(/^sup_merge:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const pendingId = ctx.match[1];
    const pending = await (0, telegram_1.findOwnedPendingAction)(pendingId, ctx.from.id);
    if (!pending || pending.type !== 'SUPPLIER_MERGE') {
        return ctx.editMessageText("⚠️ Ushbu so'rov muddati tugagan.", { reply_markup: undefined });
    }
    const { sourceId, targetId } = pending.data || {};
    try {
        await executeSupplierMerge(ctx, sourceId, targetId, ownerId);
        await (0, telegram_1.deleteOwnedPendingAction)(pendingId, ctx.from.id);
    }
    catch (err) {
        await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
    }
});
exports.suppliersHandler.callbackQuery(/^cancel_merge:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const pendingId = ctx.match[1];
    const pending = await (0, telegram_1.findOwnedPendingAction)(pendingId, ctx.from.id);
    const sourceId = pending?.data?.sourceId;
    await (0, telegram_1.deleteOwnedPendingAction)(pendingId, ctx.from.id);
    (0, telegram_1.clearSession)(ctx);
    await ctx.editMessageText('❌ Birlashtirish bekor qilindi.');
    if (sourceId)
        await sendSupplierDetails(ctx, sourceId, 'all', false);
});
exports.suppliersHandler.callbackQuery(/^confirm_merge_supplier:([^:]+):([^:]+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const [, sourceId, targetId] = ctx.match;
    try {
        await executeSupplierMerge(ctx, sourceId, targetId, ownerId);
    }
    catch (err) {
        await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
    }
});
exports.suppliersHandler.callbackQuery(/^cancel_merge_supplier:(.+)$/, async (ctx) => {
    const supplierId = ctx.match[1];
    (0, telegram_1.clearSession)(ctx);
    await ctx.editMessageText('❌ Birlashtirish bekor qilindi.');
    await sendSupplierDetails(ctx, supplierId, 'all', false);
});
exports.suppliersHandler.callbackQuery(/^sup:archive:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    await prisma_1.prisma.supplier.updateMany({ where: { id: ctx.match[1], ownerId }, data: { isActive: false } });
    cache_service_1.cacheService.invalidateSupplierNames(ownerId);
    await ctx.answerCallbackQuery({ text: "Ta'minotchi o'chirildi (Arxivlandi)." });
    await sendSuppliersPage(ctx, 1, true);
});
exports.suppliersHandler.callbackQuery(/^sup:receipts:list:(.+):(\d+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const [supplierId, rawPage] = [ctx.match[1], parseInt(ctx.match[2], 10) || 1];
    const PER_PAGE = 5;
    const allIncoming = await prisma_1.prisma.supplierTransaction.findMany({
        where: { ownerId, supplierId, type: 'INCOMING_GOODS' },
        orderBy: { date: 'asc' },
        select: { id: true, date: true, amount: true, currency: true },
    });
    const totalPages = Math.ceil(allIncoming.length / PER_PAGE) || 1;
    const currentPage = Math.max(1, Math.min(rawPage, totalPages));
    const kb = new grammy_1.InlineKeyboard();
    for (const tx of [...allIncoming].reverse().slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE)) {
        kb.text(`📄 Chek #${allIncoming.findIndex((i) => i.id === tx.id) + 1} (${(0, formatters_1.formatDateShort)(tx.date)} | ${(0, formatters_1.formatCompactAmount)(Number(tx.amount), tx.currency)})`, `sup:receipt:${tx.id}`).row();
    }
    (0, inline_1.addPaginationRow)(kb, currentPage, totalPages, `sup:receipts:list:${supplierId}:`);
    kb.text('🔙 Orqaga', `sup:v:${supplierId}`).row();
    await (0, telegram_1.replyOrEdit)(ctx, `📂 **Barcha cheklar tarixi (Sahifa ${currentPage}/${totalPages})**\n\nQuyidagi cheklardan birini tanlang:`, kb, true);
});
exports.suppliersHandler.callbackQuery(/^sup:receipt:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const tx = await prisma_1.prisma.supplierTransaction.findFirst({
        where: { id: ctx.match[1], ownerId },
        include: { supplier: { select: { name: true } } },
    });
    if (!tx)
        return ctx.answerCallbackQuery('Ushbu amaliyot topilmadi.');
    const allIncoming = await prisma_1.prisma.supplierTransaction.findMany({
        where: { ownerId, supplierId: tx.supplierId, type: 'INCOMING_GOODS' },
        orderBy: { date: 'asc' },
        select: { id: true },
    });
    const checkNo = allIncoming.findIndex((i) => i.id === tx.id) + 1;
    const receipt = (tx.formattedReceipt
        ? (0, transliterate_1.toLatinUz)(tx.formattedReceipt).replace('🧾 ELEKTRON NAKLADNOY', `🧾 NAKLADNOY CHEK #${checkNo}`)
        : `🧾 NAKLADNOY CHEK #${checkNo}\n🏢 Ta'minotchi: ${(0, transliterate_1.toLatinUz)(tx.supplier.name)}\n📅 Sana: ${(0, formatters_1.formatDate)(tx.date)}\n💰 Summa: ${(0, formatters_1.formatCurrency)(tx.amount, tx.currency)}\n${tx.description ? `\nIzoh: ${(0, transliterate_1.toLatinUz)(tx.description)}` : ''}`)
        .replace(/```/g, "'''")
        .slice(0, 3500);
    const targetInvoiceId = tx.invoiceId || tx.receiptData?.invoiceId || tx.id;
    const kb = (0, inline_1.getSavedInvoiceCardKeyboard)(targetInvoiceId, tx.supplierId, tx.photoFileId, tx.id);
    await (0, telegram_1.replyOrEdit)(ctx, `\`\`\`\n${receipt}\n\`\`\``, kb, true);
});
exports.suppliersHandler.callbackQuery('close_msg', (ctx) => ctx.deleteMessage().catch(() => { }));
exports.suppliersHandler.callbackQuery(/^sup:photo:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const tx = await prisma_1.prisma.supplierTransaction.findFirst({
        where: { id: ctx.match[1], ownerId },
        select: { photoFileId: true },
    });
    if (!tx?.photoFileId)
        return ctx.answerCallbackQuery("Asl rasm topilmadi yoki o'chirilgan.");
    await ctx.replyWithPhoto(tx.photoFileId, {
        caption: '🖼 Asl nakladnoy rasmi',
        reply_markup: new grammy_1.InlineKeyboard().text('🗑 Yopish', 'close_msg'),
    });
});
exports.suppliersHandler.callbackQuery('sup:add', async (ctx) => {
    ctx.session.step = 'SUPPLIER_ADD';
    ctx.session.tempData = {};
    await ctx.reply("➕ **Yangi ta'minotchi qo'shish**\n\nTa'minotchi nomi va ixtiyoriy telefon raqamini kiriting:\n(Masalan: `Azamat Shakar +998901234567` yoki shunchaki `Azamat Shakar`)\n\nBekor qilish uchun /start ni bosing.", { parse_mode: 'Markdown' });
});
const getCurrencySelectKeyboard = (selectedCurrency = 'UZS') => new grammy_1.InlineKeyboard()
    .text(selectedCurrency === 'UZS' ? "✅ 🇺🇿 So'mda (UZS)" : "🇺🇿 So'mda (UZS)", 'sup:set_cur:UZS')
    .text(selectedCurrency === 'USD' ? '✅ 💵 Dollarda (USD/USDT)' : '💵 Dollarda (USD/USDT)', 'sup:set_cur:USD');
const startManualSupplierTx = async (ctx, supplierId, step, action, prompt) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const supplier = await prisma_1.prisma.supplier.findFirst({
        where: { id: supplierId, ownerId },
        select: { name: true },
    });
    if (!supplier)
        return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
    const cleanName = (0, transliterate_1.toLatinUz)(supplier.name);
    ctx.session.step = step;
    ctx.session.tempData = {
        supplierId,
        activeSupplierId: supplierId,
        supplierName: cleanName,
        activeSupplierName: cleanName,
        action,
        currency: 'UZS',
        paymentCurrency: 'UZS',
    };
    await (0, telegram_1.safeReply)(ctx, prompt((0, telegram_1.sanitizeMdV1)(cleanName)), {
        parse_mode: 'Markdown',
        reply_markup: getCurrencySelectKeyboard('UZS'),
    });
};
exports.suppliersHandler.callbackQuery(/^sup:set_cur:(UZS|USD)$/, async (ctx) => {
    const selected = ctx.match[1];
    if (ctx.session.tempData) {
        ctx.session.tempData.currency = selected;
        ctx.session.tempData.paymentCurrency = selected;
    }
    await ctx.answerCallbackQuery({
        text: selected === 'USD' ? "💵 Valyuta: USD ($) tanlandi" : "🇺🇿 Valyuta: So'm (UZS) tanlandi",
    });
    if (ctx.callbackQuery.message) {
        await ctx.editMessageReplyMarkup({ reply_markup: getCurrencySelectKeyboard(selected) }).catch(() => { });
    }
});
exports.suppliersHandler.callbackQuery(/^sup:pay:(.+)$/, (ctx) => startManualSupplierTx(ctx, ctx.match[1], 'SUPPLIER_PAYMENT', 'PAYMENT', (n) => `💸 **${n}** ga to'langan pul summasini kiriting:\n` +
    `• So'mda: masalan \`500000\` yoki \`500.000\`\n` +
    `• Dollarda: masalan \`$50\`, \`50 USDT\` yoki \`50.17$\`\n\n` +
    `Pastdagi tugma orqali valyutani tanlashingiz ham mumkin:`));
exports.suppliersHandler.callbackQuery(/^sup:goods:(.+)$/, (ctx) => startManualSupplierTx(ctx, ctx.match[1], 'SUPPLIER_GOODS', 'INCOMING_GOODS', (n) => `📦 **${n}** dan qabul qilingan yuk summasini kiriting:\n` +
    `• So'mda: masalan \`500000\` yoki \`500.000\`\n` +
    `• Dollarda: masalan \`$102.17\`, \`102,17 USDT\` yoki \`102 dollar 17 sent\``));
/**
 * 3-MUAMMO & 6-MODUL: Yagona, xatosiz va dublikatsiz ta'minotchi to'lov funksiyasi (`handleSupplierPayment`).
 */
async function handleSupplierPayment(params) {
    const { ctx, ownerId, supplierId, supplierName, amount, currency, paymentSource, isCallbackEdit } = params;
    const cleanName = (0, transliterate_1.toLatinUz)(supplierName);
    const res = await supplier_service_1.SupplierService.recordSupplierPayment({
        ownerId,
        supplierId,
        supplierName: cleanName,
        amount: Number(amount),
        currency,
        paymentSource,
    });
    (0, telegram_1.clearSession)(ctx);
    const isUsd = currency === 'USD';
    const currentDebt = isUsd ? Number(res.supplier.debtUsd) : Number(res.supplier.debtUzs);
    const formattedAmt = (0, formatters_1.formatCurrency)(amount, currency);
    const formattedPostDebt = (0, formatters_1.formatCurrency)(currentDebt, currency);
    const sourceBadge = paymentSource === 'PREVIOUS_SAFE'
        ? "🏦 Kechagi puldan / Seyfdan (Z-otchyot savdosiga qo'shilmadi)"
        : "💵 Bugungi kassadan (Bugungi Z-otchyotga qo'shildi)";
    const msgText = `✅ **${(0, telegram_1.sanitizeMdV1)(cleanName)}** hisobiga **${formattedAmt}** to'lov kiritildi va ${currency} qarzdan ayirildi!\n` +
        `🗂 Manba: ${sourceBadge}\n` +
        `📊 **Yakuniy qarz qoldig'i (${currency}):** **${formattedPostDebt}**`;
    const undoKb = new grammy_1.InlineKeyboard().text('↩️ Bekor qilish (Undo)', `sup:undo:${res.transaction.id}`);
    if (isCallbackEdit && ctx.callbackQuery?.message && ctx.chat?.id) {
        await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, msgText, {
            parse_mode: 'Markdown',
            reply_markup: undoKb,
        });
    }
    else {
        await (0, telegram_1.safeReply)(ctx, msgText, {
            parse_mode: 'Markdown',
            reply_markup: undoKb,
        });
    }
    await sendSupplierDetails(ctx, supplierId, 'all', false);
    return res;
}
// MODUL 5.2: Handle 1-click payment source selection from manual supplier payment flow (`ps:T/S:spay_` + legacy)
exports.suppliersHandler.callbackQuery(/^(?:pay_source:(TODAY_CASH|PREVIOUS_SAFE)|ps:(T|S)):spay_(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const paymentSource = ctx.match[1] === 'PREVIOUS_SAFE' || ctx.match[2] === 'S' ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
    const pendingId = ctx.match[3];
    const pendingAction = await (0, telegram_1.findOwnedPendingAction)(pendingId, ctx.from.id);
    if (!pendingAction) {
        return ctx.editMessageText("⚠️ Ushbu so'rov muddati tugagan.", { reply_markup: undefined });
    }
    const { supplierId, supplierName, amount, currency } = pendingAction.data;
    try {
        await (0, telegram_1.deleteOwnedPendingAction)(pendingId, ctx.from.id);
        await handleSupplierPayment({
            ctx,
            ownerId,
            supplierId,
            supplierName,
            amount: Number(amount),
            currency,
            paymentSource,
            isCallbackEdit: true,
        });
    }
    catch (err) {
        await ctx.answerCallbackQuery({ text: "To'lovni saqlashda xatolik bo'ldi.", show_alert: true });
    }
});
exports.suppliersHandler.callbackQuery(/^cancel_spay_(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    await (0, telegram_1.deleteOwnedPendingAction)(ctx.match[1], ctx.from.id);
    (0, telegram_1.clearSession)(ctx);
    await ctx.editMessageText("❌ To'lov bekor qilindi.", { reply_markup: undefined });
});
exports.suppliersHandler.callbackQuery(/^sup:undo:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const txId = ctx.match[1];
    const transaction = await prisma_1.prisma.supplierTransaction.findFirst({ where: { id: txId, ownerId } });
    if (!transaction)
        return ctx.answerCallbackQuery('Bu amaliyot topilmadi yoki allaqachon bekor qilingan.');
    const isUsd = transaction.currency === 'USD';
    const isIncoming = transaction.type === 'INCOMING_GOODS';
    await prisma_1.prisma.$transaction(async (tx) => {
        await tx.supplier.update({
            where: { id: transaction.supplierId },
            data: isUsd
                ? { debtUsd: isIncoming ? { decrement: transaction.amount } : { increment: transaction.amount } }
                : { debtUzs: isIncoming ? { decrement: transaction.amount } : { increment: transaction.amount } },
        });
        if (transaction.type === 'PAYMENT') {
            await tx.supplierPayment.deleteMany({
                where: {
                    ownerId,
                    supplierId: transaction.supplierId,
                    amount: transaction.amount,
                    currency: transaction.currency,
                    createdAt: transaction.date,
                },
            });
        }
        await tx.supplierTransaction.delete({ where: { id: txId } });
    });
    cache_service_1.cacheService.invalidateSupplierNames(ownerId);
    await ctx.answerCallbackQuery('Amaliyot bekor qilindi va balans tiklandi!');
    await sendSupplierDetails(ctx, transaction.supplierId, 'all', false);
});
exports.suppliersHandler.on('message:text', async (ctx, next) => {
    if (!ctx.from)
        return next();
    const ownerId = String(ctx.from.id);
    if (ctx.session.step === 'AWAITING_SUPPLIER_NEW_NAME') {
        const rawTrimmed = ctx.message.text.trim();
        if (rawTrimmed.startsWith('/') || (0, menu_1.isMenuButton)(rawTrimmed)) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const rawText = (0, transliterate_1.toLatinUz)(rawTrimmed);
        const { supplierId } = ctx.session.tempData || {};
        if (!supplierId) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        try {
            const checkResult = await supplier_service_1.SupplierService.checkOrRenameSupplier(supplierId, rawText, ownerId);
            if (checkResult.status === 'MERGE_REQUIRED') {
                (0, telegram_1.clearSession)(ctx);
                const mergePending = await prisma_1.prisma.pendingAction.create({
                    data: {
                        userId: BigInt(ctx.from.id),
                        type: 'SUPPLIER_MERGE',
                        data: {
                            ownerId,
                            sourceId: checkResult.sourceSupplier.id,
                            targetId: checkResult.targetSupplier.id,
                        },
                    },
                });
                const kb = new grammy_1.InlineKeyboard()
                    .text('✅ Ha, birlashtir', `sup_merge:${mergePending.id}`)
                    .text("❌ Yo'q", `cancel_merge:${mergePending.id}`);
                return ctx.reply(`⚠️ '${(0, transliterate_1.toLatinUz)(checkResult.targetSupplier.name)}' nomli ta'minotchi bazada bor. Ikkalasini birlashtirib, barcha nakladnoy va qarzlarni (UZS va USD) bitta hisobga o'tkazaymi?`, { reply_markup: kb });
            }
            (0, telegram_1.clearSession)(ctx);
            await (0, telegram_1.safeReply)(ctx, `✅ Ta'minotchi nomi **"${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(checkResult.supplier.name))}"** ga o'zgartirildi! Barcha nakladnoy va to'lovlar tarixi to'liq saqlandi.`, { parse_mode: 'Markdown' });
            return sendSupplierDetails(ctx, checkResult.supplier.id, 'all', false);
        }
        catch (err) {
            return ctx.reply(`❌ ${err?.message || 'Xatolik yuz berdi. Qaytadan kiriting:'}`);
        }
    }
    if (ctx.session.step === 'SUPPLIER_ADD') {
        const rawText = ctx.message.text.trim();
        if (rawText.startsWith('/') || (0, menu_1.isMenuButton)(rawText)) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const phone = rawText.match(/(\+?998\d{9}|\d{9})/)?.[0] || null;
        const name = (0, transliterate_1.toLatinUz)(supplier_service_1.SupplierService.cleanSupplierName(rawText.replace(/(\+?998\d{9}|\d{9})/, '').trim()));
        if (!name || name.length < 2)
            return ctx.reply("❌ Ta'minotchi nomi kamida 2 ta harfdan iborat bo'lishi kerak. Iltimos qaytadan kiriting:");
        const existing = await prisma_1.prisma.supplier.findFirst({
            where: { ownerId, name: { equals: name, mode: 'insensitive' } },
        });
        (0, telegram_1.clearSession)(ctx);
        if (existing) {
            if (!existing.isActive) {
                await prisma_1.prisma.supplier.update({
                    where: { id: existing.id },
                    data: { isActive: true, name: (0, transliterate_1.toLatinUz)(existing.name), phone: phone || existing.phone },
                });
                cache_service_1.cacheService.invalidateSupplierNames(ownerId);
                await ctx.reply(`✅ Arxivlangan ta'minotchi (${(0, transliterate_1.toLatinUz)(existing.name)}) qayta faollashtirildi!`);
            }
            else {
                await ctx.reply(`⚠️ "${name}" nomli ta'minotchi allaqachon mavjud!`);
            }
            return sendSupplierDetails(ctx, existing.id, 'all', false);
        }
        const newSupplier = await prisma_1.prisma.supplier.create({
            data: { ownerId, name, phone, debtUzs: 0, debtUsd: 0, isActive: true },
        });
        cache_service_1.cacheService.invalidateSupplierNames(ownerId);
        await (0, telegram_1.safeReply)(ctx, `✅ Yangi ta'minotchi muvaffaqiyatli qo'shildi: *${(0, telegram_1.sanitizeMdV1)(newSupplier.name)}*`, {
            parse_mode: 'Markdown',
        });
        return sendSupplierDetails(ctx, newSupplier.id, 'all', false);
    }
    if (ctx.session.step !== 'SUPPLIER_PAYMENT' && ctx.session.step !== 'SUPPLIER_GOODS')
        return next();
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/') || (0, menu_1.isMenuButton)(rawText)) {
        (0, telegram_1.clearSession)(ctx);
        return next();
    }
    const tempData = ctx.session.tempData || {};
    const supplierId = tempData.activeSupplierId || tempData.supplierId;
    const supplierName = tempData.activeSupplierName || tempData.supplierName;
    const action = tempData.action;
    if (!supplierId || !supplierName) {
        (0, telegram_1.clearSession)(ctx);
        return next();
    }
    const parsed = (0, formatters_1.parseCurrencyAndAmount)(rawText);
    const amount = (0, formatters_1.parseSmartAmount)(rawText) || parsed.amount;
    const selectedCur = tempData.paymentCurrency || tempData.currency;
    const currency = parsed.currency === 'USD' ? 'USD' : selectedCur === 'USD' ? 'USD' : 'UZS';
    if (!amount || amount <= 0 || isNaN(amount))
        return ctx.reply("Iltimos, to'g'ri summa kiriting (masalan: 500000, 500.000 yoki $50.17). To'xtatish uchun /start ni bosing.");
    if (amount > 10_000_000_000)
        return ctx.reply("❌ Kiritilgan summa o'ta katta. Iltimos tekshirib qaytadan kiriting (maks: 10 mlrd). To'xtatish uchun /start.");
    const isPay = action === 'PAYMENT' || ctx.session.step === 'SUPPLIER_PAYMENT';
    const isUsd = currency === 'USD';
    const safeSuppName = (0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(supplierName));
    // MODUL 5.2: For supplier payment in UZS, ask whether it came from TODAY_CASH or PREVIOUS_SAFE (unless specified in text)
    if (isPay) {
        const isPrevSafeText = /\b(kecha(?:gi)?|seyf(?:dan)?|seif(?:dan)?)\b/i.test(rawText);
        const isTodayText = /\b(bugun(?:gi)?|kassa(?:dan)?)\b/i.test(rawText);
        if (!isPrevSafeText && !isTodayText && !isUsd) {
            const pendingAction = await prisma_1.prisma.pendingAction.create({
                data: {
                    userId: BigInt(ctx.from.id),
                    type: 'MANUAL_SUPPLIER_PAYMENT',
                    data: { ownerId, supplierId, supplierName: (0, transliterate_1.toLatinUz)(supplierName), amount, currency },
                },
            });
            await (0, telegram_1.safeReply)(ctx, `💸 **${safeSuppName}** ga **${(0, formatters_1.formatCurrency)(amount, currency)}** to'lov.\n\n` +
                `👇 **Ushbu pul qaysi manbadan berildi?**`, {
                parse_mode: 'Markdown',
                reply_markup: (0, inline_1.getPaymentSourceConfirmationKeyboard)(`spay_${pendingAction.id}`),
            });
            (0, telegram_1.clearSession)(ctx);
            return;
        }
        const paymentSource = isPrevSafeText ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
        return handleSupplierPayment({
            ctx,
            ownerId,
            supplierId,
            supplierName,
            amount,
            currency,
            paymentSource,
            isCallbackEdit: false,
        });
    }
    const { createdTx, currentDebt } = await prisma_1.prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findFirst({
            where: { id: supplierId, ownerId },
            select: { debtUzs: true, debtUsd: true },
        });
        if (!supplier)
            throw new Error('Not found');
        const prevDebt = Number(isUsd ? supplier.debtUsd : supplier.debtUzs);
        const currentDebt = Number((prevDebt + amount).toFixed(2));
        const formattedAmt = (0, formatters_1.formatCurrency)(amount, currency);
        const formattedPostDebt = (0, formatters_1.formatCurrency)(currentDebt, currency);
        const formattedReceipt = `🧾 ELEKTRON NAKLADNOY\n` +
            `🏢 Ta'minotchi: ${(0, transliterate_1.toLatinUz)(supplierName)}\n` +
            `📅 Sana: ${(0, formatters_1.formatDate)(new Date())}\n` +
            `📥 Kiritish usuli: ✍️ Qo'lda kiritish (Manual)\n` +
            `-----------------------------\n` +
            `Yuk olish - ${formattedAmt}\n` +
            `-----------------------------\n` +
            `💰 Amaliyot summasi: ${formattedAmt}\n` +
            `📦 Ushbu amaliyotdan keyingi qarz: ${formattedPostDebt}\n`;
        const [createdTx] = await Promise.all([
            tx.supplierTransaction.create({
                data: {
                    ownerId,
                    supplierId,
                    type: 'INCOMING_GOODS',
                    paymentSource: 'TODAY_CASH',
                    amount,
                    currency,
                    sourceType: 'MANUAL',
                    formattedReceipt,
                    description: "Qo'lda kiritilgan kirim (yuk)",
                },
            }),
            tx.supplier.update({
                where: { id: supplierId },
                data: isUsd ? { debtUsd: currentDebt } : { debtUzs: currentDebt },
            }),
        ]);
        return { createdTx, currentDebt };
    });
    cache_service_1.cacheService.invalidateSupplierNames(ownerId);
    (0, telegram_1.clearSession)(ctx);
    const formattedAmt = (0, formatters_1.formatCurrency)(amount, currency);
    const formattedPostDebt = (0, formatters_1.formatCurrency)(currentDebt, currency);
    await (0, telegram_1.safeReply)(ctx, `✅ **${safeSuppName}** dan **${formattedAmt}** lik yuk qabul qilindi va ${currency} qarzga qo'shildi!\n📊 **Yakuniy qarz qoldig'i (${currency}):** **${formattedPostDebt}**`, {
        parse_mode: 'Markdown',
        reply_markup: new grammy_1.InlineKeyboard().text('↩️ Bekor qilish (Undo)', `sup:undo:${createdTx.id}`),
    });
    await sendSupplierDetails(ctx, supplierId, 'all', false);
});
