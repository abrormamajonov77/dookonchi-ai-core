"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suppliersHandler = void 0;
exports.parseAmountAndOptionalNote = parseAmountAndOptionalNote;
exports.sendSupplierDetails = sendSupplierDetails;
exports.handleSupplierPayment = handleSupplierPayment;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const formatters_1 = require("../../utils/formatters");
const supplier_service_1 = require("../../services/supplier.service");
const export_service_1 = require("../../services/export.service");
const cache_service_1 = require("../../services/cache.service");
const inline_1 = require("../keyboards/inline");
const telegram_1 = require("../../utils/telegram");
const menu_1 = require("../keyboards/menu");
const transliterate_1 = require("../../utils/transliterate");
exports.suppliersHandler = new grammy_1.Composer();
/**
 * Parses a leading numeric amount plus an optional trailing note, e.g.:
 * - "250000 5 ta yog' singan" -> { amount: 250000, currency: defaultCurrency, note: "5 ta yog' singan" }
 * - "250.000 5 ta yog' singan" -> { amount: 250000, currency: defaultCurrency, note: "5 ta yog' singan" }
 * - "$15.50 quti ezilgan" -> { amount: 15.5, currency: 'USD', note: "quti ezilgan" }
 */
function parseAmountAndOptionalNote(rawText, defaultCurrency = 'UZS') {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) {
        return { amount: 0, currency: defaultCurrency };
    }
    const leadingAmtRe = /^\s*(\$?\s*(?:\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d{1,2})?)\s*(?:(?:mln|million|ming|k)\b)?(?:\s*(?:\$|usd|usdt|dollar(?:u)?|so['`’]?m|uzs|som)\b|\$)?)(?:\s+(.*))?$/i;
    const match = trimmed.match(leadingAmtRe);
    if (match) {
        const amountToken = match[1].trim();
        const noteRaw = (match[2] || '').trim();
        const parsedToken = (0, formatters_1.parseCurrencyAndAmount)(amountToken);
        const amount = (0, formatters_1.parseSmartAmount)(amountToken) || parsedToken.amount;
        const hasExplicitUsd = /(\$|usd\b|usdt\b|dollar)/i.test(amountToken);
        const hasExplicitUzs = /(so['`’]?m\b|uzs\b|som\b)/i.test(amountToken);
        const currency = hasExplicitUsd
            ? 'USD'
            : hasExplicitUzs
                ? 'UZS'
                : defaultCurrency;
        return {
            amount,
            currency,
            note: noteRaw ? (0, transliterate_1.toLatinUz)(noteRaw) : undefined,
        };
    }
    const fallbackParsed = (0, formatters_1.parseCurrencyAndAmount)(trimmed);
    const amount = (0, formatters_1.parseSmartAmount)(trimmed) || fallbackParsed.amount;
    const currency = /(\$|usd\b|usdt\b|dollar)/i.test(trimmed)
        ? 'USD'
        : defaultCurrency;
    return { amount, currency };
}
function formatCategoryTitle(category) {
    if (category === 'CHEKLAR')
        return '🧾 Cheklar (Kelgan yuklar)';
    if (category === 'PULLAR')
        return "💵 Pullar (Berilgan to'lovlar)";
    return '🔄 Vozvratlar (Qaytarilgan tovarlar)';
}
function formatDebtLines(debtUzs, debtUsd) {
    const uzsLine = debtUzs >= 0
        ? `💰 **Joriy qarz (UZS):** ${(0, formatters_1.formatSom)(debtUzs)}`
        : `🟢 **Haqimiz (UZS):** ${(0, formatters_1.formatSom)(Math.abs(debtUzs))}`;
    const usdLine = debtUsd >= 0
        ? `💵 **Joriy qarz (USD):** ${(0, formatters_1.formatUsd)(debtUsd, true)}`
        : `🟢 **Haqimiz (USD):** ${(0, formatters_1.formatUsd)(Math.abs(debtUsd), true)}`;
    return `${uzsLine}\n${usdLine}`;
}
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
async function sendSupplierDetails(ctx, supplierId, _filter = 'all', isEdit = false) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const supplier = await prisma_1.prisma.supplier.findFirst({
        where: { id: supplierId, ownerId },
        select: { id: true, name: true, phone: true },
    });
    if (!supplier) {
        return ctx.callbackQuery ? ctx.answerCallbackQuery("Ta'minotchi topilmadi.") : undefined;
    }
    const balance = await supplier_service_1.SupplierService.getSupplierBalance(ownerId, supplier.id);
    const incParts = [];
    if (balance.uzs.totalIncoming > 0 || balance.usd.totalIncoming === 0) {
        incParts.push((0, formatters_1.formatSom)(balance.uzs.totalIncoming));
    }
    if (balance.usd.totalIncoming > 0)
        incParts.push((0, formatters_1.formatUsd)(balance.usd.totalIncoming));
    const payParts = [];
    if (balance.uzs.totalPayments > 0 || balance.usd.totalPayments === 0) {
        payParts.push((0, formatters_1.formatSom)(balance.uzs.totalPayments));
    }
    if (balance.usd.totalPayments > 0)
        payParts.push((0, formatters_1.formatUsd)(balance.usd.totalPayments));
    const retParts = [];
    if (balance.uzs.totalReturns > 0)
        retParts.push((0, formatters_1.formatSom)(balance.uzs.totalReturns));
    if (balance.usd.totalReturns > 0)
        retParts.push((0, formatters_1.formatUsd)(balance.usd.totalReturns));
    const phoneLine = supplier.phone ? `📞 **Tel:** ${(0, telegram_1.sanitizeMdV1)(supplier.phone)}\n` : '';
    const retLine = retParts.length ? `\n🔄 Vozvrat: ${retParts.join(' | ')}` : '';
    const text = `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(supplier.name))}\n` +
        phoneLine +
        `${formatDebtLines(balance.debtUzs, balance.debtUsd)}\n\n` +
        `📊 **Umumiy ko'rsatkichlar:**\n` +
        `📥 Jami kelgan yuk: ${incParts.join(' | ')}\n` +
        `📤 Jami berilgan pul: ${payParts.join(' | ')}` +
        retLine;
    const kb = (0, inline_1.getSupplierCardKeyboard)(supplier.id);
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
async function sendSupplierCategoryPage(ctx, supplierId, catCode, page, isEdit = true) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const category = (0, inline_1.categoryCodeToCategory)(catCode);
    const supplier = await prisma_1.prisma.supplier.findFirst({
        where: { id: supplierId, ownerId },
        select: { id: true, name: true },
    });
    if (!supplier) {
        return ctx.callbackQuery ? ctx.answerCallbackQuery("Ta'minotchi topilmadi.") : undefined;
    }
    const paginated = await supplier_service_1.SupplierService.getSupplierRecordsPaginated(ownerId, supplierId, category, page, 5);
    const title = formatCategoryTitle(category);
    const supName = (0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(supplier.name));
    const body = paginated.items.length > 0
        ? `Jami: **${paginated.total} ta** yozuv (Sahifa **${paginated.page}/${paginated.totalPages}**)\n\nBatafsil ko'rish, tahrirlash yoki o'chirish uchun quyidagi yozuvlardan birini tanlang:`
        : "Hozircha bu bo'limda yozuvlar mavjud emas.";
    const text = `${title}\n🏢 **${supName}**\n\n${body}`;
    const kb = (0, inline_1.getSupplierCategoryListKeyboard)(supplierId, catCode, paginated.items, paginated.page, paginated.totalPages, formatters_1.formatDateShort);
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
async function sendSupplierRecordDetailView(ctx, catCode, recordId, isEdit = true) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const category = (0, inline_1.categoryCodeToCategory)(catCode);
    const record = await supplier_service_1.SupplierService.getSupplierRecordDetail(ownerId, category, recordId);
    if (!record) {
        return ctx.callbackQuery
            ? ctx.answerCallbackQuery("Yozuv topilmadi yoki o'chirilgan.")
            : ctx.reply("Yozuv topilmadi yoki o'chirilgan.");
    }
    const header = category === 'CHEKLAR'
        ? '🧾 **Chek tafsilotlari**'
        : category === 'PULLAR'
            ? "💵 **To'lov tafsilotlari**"
            : '🔄 **Vozvrat tafsilotlari**';
    const lines = [
        header,
        '',
        `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)(record.supplierName)}`,
        `📅 **Sana:** ${(0, formatters_1.formatDate)(record.date)}`,
        `💰 **Summa:** ${(0, formatters_1.formatCurrency)(record.amount, record.currency)}`,
        `💱 **Valyuta:** ${record.currency}`,
    ];
    if (category === 'CHEKLAR') {
        if (record.invoiceNo) {
            lines.push(`🔢 **Nakladnoy №:** ${(0, telegram_1.sanitizeMdV1)(record.invoiceNo)}`);
        }
        if (record.paymentType) {
            const pLabel = record.paymentType === 'CASH'
                ? '💵 Naqd'
                : record.paymentType === 'PARTIAL'
                    ? '⚖️ Qisman naqd'
                    : '📝 Nasiya';
            lines.push(`🏷 **To'lov turi:** ${pLabel}`);
            if (record.paymentType === 'CASH' || record.paymentType === 'PARTIAL') {
                const badge = record.cashSourceBadge || (record.paymentSource === 'PREVIOUS_SAFE' ? 'Seyfdan' : 'Kassadan');
                const srcText = badge === 'Seyfdan' ? '🔐 Seyfdan (kechagi pul)' : '💵 Bugungi kassadan';
                lines.push(`🗂 **Pul manbasi:** ${srcText} (${badge})`);
            }
        }
        if (record.discountAmount && record.discountAmount > 0 && record.originalAmount) {
            lines.push(`📦 **Asl summa:** ${(0, formatters_1.formatCurrency)(record.originalAmount, record.currency)}`);
            lines.push(`🎁 **Skidka:** -${(0, formatters_1.formatCurrency)(record.discountAmount, record.currency)}`);
        }
    }
    else if (category === 'PULLAR' && record.paymentSource) {
        const srcLabel = record.paymentSource === 'PREVIOUS_SAFE' ? '🏦 Kechagi puldan / Seyfdan' : '💵 Bugungi kassadan';
        lines.push(`🗂 **Manba:** ${srcLabel}`);
    }
    if (record.note) {
        lines.push(`📝 **Izoh:** ${(0, telegram_1.sanitizeMdV1)(record.note)}`);
    }
    if (category === 'CHEKLAR' && record.items && record.items.length > 0) {
        lines.push('', `📋 **Tovarlar (${record.items.length} ta):**`);
        for (const it of record.items.slice(0, 15)) {
            lines.push(`• ${(0, telegram_1.sanitizeMdV1)(it.rawName)} — ${it.quantity} ${(0, telegram_1.sanitizeMdV1)(it.unit)} × ${(0, formatters_1.formatCurrency)(it.unitPrice, it.currency)} = ${(0, formatters_1.formatCurrency)(it.totalPrice, it.currency)}`);
        }
        if (record.items.length > 15) {
            lines.push(`... va yana ${record.items.length - 15} ta mahsulot`);
        }
    }
    const kb = (0, inline_1.getSupplierRecordDetailKeyboard)(catCode, record.id, record.supplierId, record.photoFileId);
    await (0, telegram_1.replyOrEdit)(ctx, lines.join('\n'), kb, isEdit);
}
exports.suppliersHandler.hears("📦 Ta'minotchilar", async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await sendSuppliersPage(ctx, 1);
});
exports.suppliersHandler.callbackQuery(/^sup:p:(\d+)$/, (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    return sendSuppliersPage(ctx, parseInt(ctx.match[1], 10), true);
});
exports.suppliersHandler.callbackQuery(/^sup:v:(.+)$/, (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    return sendSupplierDetails(ctx, ctx.match[1], 'all', true);
});
exports.suppliersHandler.callbackQuery(/^sup:tx:(.+):(all|month|today)$/, (ctx) => sendSupplierDetails(ctx, ctx.match[1], ctx.match[2], true));
// Paginated category views: Cheklar (C), Pullar (P), Vozvrat (V)
exports.suppliersHandler.callbackQuery(/^sup:cat:(C|P|V):([^:]+):(\d+)$/, (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    return sendSupplierCategoryPage(ctx, ctx.match[2], ctx.match[1], parseInt(ctx.match[3], 10) || 1, true);
});
// Record detail view
exports.suppliersHandler.callbackQuery(/^sup:rec:(C|P|V):(.+)$/, (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    return sendSupplierRecordDetailView(ctx, ctx.match[1], ctx.match[2], true);
});
// Record edit amount prompt
exports.suppliersHandler.callbackQuery(/^sup:ed:(C|P|V):(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const catCode = ctx.match[1];
    const recordId = ctx.match[2];
    const recordType = (0, inline_1.categoryCodeToCategory)(catCode);
    const record = await supplier_service_1.SupplierService.getSupplierRecordDetail(ownerId, recordType, recordId);
    if (!record) {
        return ctx.answerCallbackQuery("Yozuv topilmadi yoki ruxsat yo'q.");
    }
    ctx.session.step = 'SUPPLIER_RECORD_EDIT_AMOUNT';
    ctx.session.supplierEditRecord = {
        recordType,
        recordId: record.id,
        supplierId: record.supplierId,
        supplierName: record.supplierName,
        currency: record.currency,
        oldAmount: record.amount,
    };
    const kb = new grammy_1.InlineKeyboard().text('❌ Bekor qilish', `sup:rec:${catCode}:${record.id}`);
    await (0, telegram_1.replyOrEdit)(ctx, `✏️ **Summani tahrirlash**\n\n` +
        `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)(record.supplierName)}\n` +
        `📅 **Sana:** ${(0, formatters_1.formatDate)(record.date)}\n` +
        `💰 **Joriy summa:** ${(0, formatters_1.formatCurrency)(record.amount, record.currency)}\n\n` +
        `Yangi summani kiriting (${record.currency}):\n` +
        `Masalan: \`500000\` yoki \`500.000\` (USD uchun: \`125.50\`)`, kb, true);
});
// Record delete confirmation prompt
exports.suppliersHandler.callbackQuery(/^sup:del:(C|P|V):(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const catCode = ctx.match[1];
    const recordId = ctx.match[2];
    const recordType = (0, inline_1.categoryCodeToCategory)(catCode);
    const record = await supplier_service_1.SupplierService.getSupplierRecordDetail(ownerId, recordType, recordId);
    if (!record) {
        return ctx.answerCallbackQuery("Yozuv topilmadi yoki allaqachon o'chirilgan.");
    }
    const text = `⚠️ **Ushbu yozuvni o'chirishni tasdiqlaysizmi?**\n\n` +
        `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)(record.supplierName)}\n` +
        `📅 **Sana:** ${(0, formatters_1.formatDate)(record.date)}\n` +
        `💰 **Summa:** ${(0, formatters_1.formatCurrency)(record.amount, record.currency)}\n` +
        (record.note ? `📝 **Izoh:** ${(0, telegram_1.sanitizeMdV1)(record.note)}\n` : '') +
        `\n_O'chirilgandan so'ng ta'minotchi balansi avtomatik qayta hisoblanadi._`;
    await (0, telegram_1.replyOrEdit)(ctx, text, (0, inline_1.getSupplierRecordDeleteConfirmKeyboard)(catCode, record.id), true);
});
// Record delete execute
exports.suppliersHandler.callbackQuery(/^sup:delok:(C|P|V):(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const catCode = ctx.match[1];
    const recordId = ctx.match[2];
    const recordType = (0, inline_1.categoryCodeToCategory)(catCode);
    try {
        const res = await supplier_service_1.SupplierService.deleteSupplierRecord(ownerId, recordType, recordId);
        await ctx.answerCallbackQuery({ text: "✅ Yozuv o'chirildi va balans yangilandi!" });
        const deletedLabel = (0, formatters_1.formatCurrency)(res.deletedAmount, res.currency);
        await (0, telegram_1.replyOrEdit)(ctx, `🗑 **Yozuv muvaffaqiyatli o'chirildi!**\n\n` +
            `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(res.supplier.name))}\n` +
            `❌ **O'chirilgan summa:** ${deletedLabel}\n\n` +
            `${formatDebtLines(res.balance.debtUzs, res.balance.debtUsd)}`, new grammy_1.InlineKeyboard()
            .text("📋 Bo'limga qaytish", `sup:cat:${catCode}:${res.supplierId}:1`)
            .row()
            .text("🏢 Ta'minotchi kartasi", `sup:v:${res.supplierId}`), true);
    }
    catch (err) {
        await ctx.answerCallbackQuery({ text: err?.message || "O'chirishda xatolik yuz berdi.", show_alert: true });
    }
});
// Vozvrat (Return) Step 1: Select Currency
exports.suppliersHandler.callbackQuery(/^sup:ret:(.+)$/, async (ctx) => {
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
    (0, telegram_1.clearSession)(ctx);
    await (0, telegram_1.replyOrEdit)(ctx, `🔄 **Vozvrat (Tovar qaytarish)**\n\n` +
        `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(supplier.name))}\n` +
        `_Eslatma: Vozvrat qarzni kamaytiradi, lekin kassadagi naqd pulga ta'sir qilmaydi._\n\n` +
        `👇 Vozvrat valyutasini tanlang:`, (0, inline_1.getSupplierReturnCurrencyKeyboard)(supplier.id), true);
});
// Vozvrat Step 2: Prompt for amount + optional reason
exports.suppliersHandler.callbackQuery(/^sup:retc:(UZS|USD):(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const currency = ctx.match[1];
    const supplierId = ctx.match[2];
    const supplier = await prisma_1.prisma.supplier.findFirst({
        where: { id: supplierId, ownerId },
        select: { id: true, name: true },
    });
    if (!supplier)
        return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
    const cleanName = (0, transliterate_1.toLatinUz)(supplier.name);
    ctx.session.step = 'SUPPLIER_RETURN_INPUT';
    ctx.session.supplierReturn = {
        supplierId: supplier.id,
        supplierName: cleanName,
        currency,
    };
    const exampleText = currency === 'USD'
        ? "`25.50 3 ta quti singan` yoki `25.50`"
        : "`250000 5 ta yog' singan` yoki `250000`";
    const kb = new grammy_1.InlineKeyboard().text('❌ Bekor qilish', `sup:v:${supplier.id}`);
    await (0, telegram_1.replyOrEdit)(ctx, `🔄 **Vozvrat kiritish (${currency})**\n\n` +
        `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)(cleanName)}\n\n` +
        `Vozvrat summasini va ixtiyoriy sababini yozib yuboring:\n` +
        `Masalan: ${exampleText}`, kb, true);
});
// PDF History (Sverka) Export
exports.suppliersHandler.callbackQuery(/^sup:pdf:(.+)$/, async (ctx) => {
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
    await ctx.answerCallbackQuery({ text: '⏳ Sverka (PDF) tayyorlanmoqda...' });
    const loadingMsg = await ctx
        .reply(`⏳ **${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(supplier.name))}** uchun to'liq tarix (PDF Sverka) tayyorlanmoqda...`, {
        parse_mode: 'Markdown',
    })
        .catch(() => null);
    try {
        await (0, telegram_1.withChatAction)(ctx, 'upload_document', async () => {
            const { buffer, filename } = await export_service_1.ExportService.generateSupplierHistoryPdf(ownerId, supplierId);
            await ctx.replyWithDocument(new grammy_1.InputFile(buffer, filename), {
                caption: `📄 ${(0, transliterate_1.toLatinUz)(supplier.name)} — To'liq hisob-kitob tarixi (Sverka)`,
            });
        });
    }
    catch (err) {
        await ctx.reply(`❌ PDF tayyorlashda xatolik: ${err?.message || "Qaytadan urinib ko'ring."}`);
    }
    finally {
        await (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, loadingMsg?.message_id);
    }
});
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
exports.suppliersHandler.callbackQuery(/^sup:receipts:list:(.+):(\d+)$/, (ctx) => sendSupplierCategoryPage(ctx, ctx.match[1], 'C', parseInt(ctx.match[2], 10) || 1, true));
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
    const linkedInvoiceId = tx.invoiceId || tx.receiptData?.invoiceId || null;
    const linkedInvoice = linkedInvoiceId
        ? await prisma_1.prisma.invoice.findFirst({
            where: { id: String(linkedInvoiceId), ownerId },
            select: { imageFileId: true },
        })
        : null;
    const targetInvoiceId = linkedInvoiceId || tx.id;
    const originalPhotoFileId = linkedInvoice?.imageFileId || tx.photoFileId;
    const kb = (0, inline_1.getSavedInvoiceCardKeyboard)(targetInvoiceId, tx.supplierId, originalPhotoFileId, tx.id);
    await (0, telegram_1.replyOrEdit)(ctx, `\`\`\`\n${receipt}\n\`\`\``, kb, true);
});
exports.suppliersHandler.callbackQuery('close_msg', (ctx) => ctx.deleteMessage().catch(() => { }));
exports.suppliersHandler.callbackQuery(/^sup:photo:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const refId = ctx.match[1];
    const tx = await prisma_1.prisma.supplierTransaction.findFirst({
        where: { id: refId, ownerId },
        select: { photoFileId: true, invoiceId: true, receiptData: true },
    });
    const linkedInvoiceId = tx?.invoiceId || tx?.receiptData?.invoiceId || refId;
    const invoice = await prisma_1.prisma.invoice.findFirst({
        where: { id: String(linkedInvoiceId), ownerId },
        select: { imageFileId: true },
    });
    const originalFileId = invoice?.imageFileId || tx?.photoFileId;
    if (!originalFileId)
        return ctx.answerCallbackQuery("Asl rasm topilmadi yoki o'chirilgan.");
    const closeKb = new grammy_1.InlineKeyboard().text('🗑 Yopish', 'close_msg');
    await ctx
        .replyWithPhoto(originalFileId, {
        caption: '🖼 Asl nakladnoy rasmi',
        reply_markup: closeKb,
    })
        .catch(() => ctx.replyWithDocument(originalFileId, {
        caption: '🖼 Asl nakladnoy rasmi',
        reply_markup: closeKb,
    }));
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
    if (ctx.session.step === 'SUPPLIER_RECORD_EDIT_AMOUNT') {
        const rawTrimmed = ctx.message.text.trim();
        if (rawTrimmed.startsWith('/') || (0, menu_1.isMenuButton)(rawTrimmed)) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const editState = ctx.session.supplierEditRecord;
        if (!editState) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const parsed = (0, formatters_1.parseCurrencyAndAmount)(rawTrimmed);
        const newAmount = (0, formatters_1.parseSmartAmount)(rawTrimmed) || parsed.amount;
        if (!newAmount || newAmount <= 0 || isNaN(newAmount)) {
            return ctx.reply("❌ Iltimos, to'g'ri summa kiriting (masalan: `500000`, `500.000` yoki `125.50`). Bekor qilish uchun /start ni bosing.", { parse_mode: 'Markdown' });
        }
        if (newAmount > 10_000_000_000) {
            return ctx.reply("❌ Kiritilgan summa o'ta katta (maks: 10 mlrd). Qaytadan kiriting:");
        }
        try {
            const res = await supplier_service_1.SupplierService.updateSupplierRecordAmount(ownerId, editState.recordType, editState.recordId, newAmount);
            (0, telegram_1.clearSession)(ctx);
            const catCode = (0, inline_1.categoryToCode)(res.recordType);
            await (0, telegram_1.safeReply)(ctx, `✅ **Summa muvaffaqiyatli yangilandi!**\n\n` +
                `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(res.supplier.name))}\n` +
                `🔄 **O'zgarish:** ${(0, formatters_1.formatCurrency)(res.oldAmount, res.currency)} ➡️ **${(0, formatters_1.formatCurrency)(res.newAmount, res.currency)}**\n\n` +
                `${formatDebtLines(res.balance.debtUzs, res.balance.debtUsd)}`, {
                parse_mode: 'Markdown',
                reply_markup: new grammy_1.InlineKeyboard()
                    .text("📋 Bo'limga qaytish", `sup:cat:${catCode}:${res.supplierId}:1`)
                    .row()
                    .text("🏢 Ta'minotchi kartasi", `sup:v:${res.supplierId}`),
            });
            return;
        }
        catch (err) {
            (0, telegram_1.clearSession)(ctx);
            return ctx.reply(`❌ ${err?.message || "Summani yangilashda xatolik yuz berdi."}`);
        }
    }
    if (ctx.session.step === 'SUPPLIER_RETURN_INPUT') {
        const rawTrimmed = ctx.message.text.trim();
        if (rawTrimmed.startsWith('/') || (0, menu_1.isMenuButton)(rawTrimmed)) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const retState = ctx.session.supplierReturn;
        if (!retState) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        const parsed = parseAmountAndOptionalNote(rawTrimmed, retState.currency);
        if (!parsed.amount || parsed.amount <= 0 || isNaN(parsed.amount)) {
            return ctx.reply("❌ Iltimos, to'g'ri vozvrat summasini kiriting (masalan: `250000 5 ta yog' singan` yoki `250000`).", { parse_mode: 'Markdown' });
        }
        if (parsed.amount > 10_000_000_000) {
            return ctx.reply("❌ Kiritilgan summa o'ta katta (maks: 10 mlrd). Qaytadan kiriting:");
        }
        try {
            const res = await supplier_service_1.SupplierService.addSupplierReturn(ownerId, retState.supplierId, parsed.amount, parsed.currency, parsed.note);
            (0, telegram_1.clearSession)(ctx);
            const noteLine = parsed.note ? `📝 **Sabab:** ${(0, telegram_1.sanitizeMdV1)(parsed.note)}\n` : '';
            await (0, telegram_1.safeReply)(ctx, `✅ **Vozvrat muvaffaqiyatli saqlandi!**\n\n` +
                `🏢 **Ta'minotchi:** ${(0, telegram_1.sanitizeMdV1)((0, transliterate_1.toLatinUz)(res.supplier.name))}\n` +
                `🔄 **Vozvrat summasi:** -${(0, formatters_1.formatCurrency)(parsed.amount, parsed.currency)}\n` +
                noteLine +
                `_Kassa naqd puliga ta'sir qilmadi._\n\n` +
                `${formatDebtLines(res.balance.debtUzs, res.balance.debtUsd)}`, {
                parse_mode: 'Markdown',
                reply_markup: new grammy_1.InlineKeyboard().text('↩️ Bekor qilish (Undo)', `sup:undo:${res.transaction.id}`),
            });
            await sendSupplierDetails(ctx, retState.supplierId, 'all', false);
            return;
        }
        catch (err) {
            (0, telegram_1.clearSession)(ctx);
            return ctx.reply(`❌ ${err?.message || "Vozvratni saqlashda xatolik yuz berdi."}`);
        }
    }
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
