"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDiscountConfirmationKeyboard = exports.getTemplateConfirmKeyboard = void 0;
exports.getConfirmationKeyboard = getConfirmationKeyboard;
exports.getPaymentSourceConfirmationKeyboard = getPaymentSourceConfirmationKeyboard;
exports.getFuzzySupplierSuggestionKeyboard = getFuzzySupplierSuggestionKeyboard;
exports.getInvoiceConfirmationKeyboard = getInvoiceConfirmationKeyboard;
exports.getDuplicateInvoiceWarningKeyboard = getDuplicateInvoiceWarningKeyboard;
exports.getSavedInvoiceCardKeyboard = getSavedInvoiceCardKeyboard;
exports.addPaginationRow = addPaginationRow;
exports.addTwoColButtons = addTwoColButtons;
exports.getDisambiguationKeyboard = getDisambiguationKeyboard;
exports.categoryCodeToCategory = categoryCodeToCategory;
exports.categoryToCode = categoryToCode;
exports.getSupplierCardKeyboard = getSupplierCardKeyboard;
exports.getSupplierCategoryListKeyboard = getSupplierCategoryListKeyboard;
exports.getSupplierRecordDetailKeyboard = getSupplierRecordDetailKeyboard;
exports.getSupplierRecordDeleteConfirmKeyboard = getSupplierRecordDeleteConfirmKeyboard;
exports.getSupplierReturnCurrencyKeyboard = getSupplierReturnCurrencyKeyboard;
exports.getOnboardingCarouselKeyboard = getOnboardingCarouselKeyboard;
const grammy_1 = require("grammy");
const formatters_1 = require("../../utils/formatters");
const transliterate_1 = require("../../utils/transliterate");
function getConfirmationKeyboard(actionId, copyTextContent) {
    const kb = new grammy_1.InlineKeyboard();
    if (copyTextContent)
        kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
    return kb.text('✅ Tasdiqlash', `confirm_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);
}
/**
 * MODUL 5.2: 1-Click Payment Source Selection for Supplier Payments
 */
function getPaymentSourceConfirmationKeyboard(actionId) {
    return new grammy_1.InlineKeyboard()
        .text('💵 Bugungi kassadan (Z-otchyotga kiradi)', `ps:T:${actionId}`)
        .row()
        .text('🏦 Kechagi puldan / Seyfdan (Z-otchyotga kirmaydi)', `ps:S:${actionId}`)
        .row()
        .text('❌ Bekor qilish', `cancel_${actionId}`);
}
/**
 * MODUL 4.2: Fuzzy Supplier Typo Guard Keyboard ("Dinar" vs "Diner")
 */
function getFuzzySupplierSuggestionKeyboard(_existingSupplierId, existingSupplierName, inputName, actionId) {
    const cleanExisting = (0, transliterate_1.toLatinUz)(existingSupplierName).slice(0, 28);
    const cleanInput = (0, transliterate_1.toLatinUz)(inputName).slice(0, 28);
    return new grammy_1.InlineKeyboard()
        .text(`✅ Ha, "${cleanExisting}" ga qo'shish`, `sf_use:${actionId}`)
        .row()
        .text(`➕ Yo'q, "${cleanInput}" deb yangi ochish`, `sf_new:${actionId}`)
        .row()
        .text('❌ Bekor qilish', `sf_no:${actionId}`);
}
const getTemplateConfirmKeyboard = (editCb, actionId) => new grammy_1.InlineKeyboard()
    .text('✏️ Tahrirlash', editCb)
    .row()
    .text('✅ Tasdiqlash', `confirm_${actionId}`)
    .text('❌ Bekor qilish', `cancel_${actionId}`);
exports.getTemplateConfirmKeyboard = getTemplateConfirmKeyboard;
function getInvoiceConfirmationKeyboard(actionId, copyTextContent, currency = 'UZS') {
    const pendingRef = actionId.replace(/^i_/, '');
    const kb = new grammy_1.InlineKeyboard();
    if (copyTextContent)
        kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
    return kb
        .text("🏷 Skidkani o'zgartirish", `edit_invoice_discount:p_${pendingRef}`)
        .text('❌ Skidkani olib tashlash', `clear_invoice_discount:p_${pendingRef}`)
        .row()
        .text("✏️ Umumiy summani qo'lda kiritish", `edit_invoice_total:p_${pendingRef}`)
        .row()
        .text(`💱 Valyutani o'zgartirish (UZS ↔ USD) [${currency}]`, `toggle_invoice_currency:p_${pendingRef}`)
        .row()
        .text('📝 Nasiyaga olindi', `confirm_invdebt_${actionId}`)
        .text('💵 Naqdga olindi', `confirm_invcash_${actionId}`)
        .row()
        .text('❌ Bekor qilish', `cancel_${actionId}`);
}
function getDuplicateInvoiceWarningKeyboard(pendingId) {
    return new grammy_1.InlineKeyboard()
        .text("⚠️ Bu haqiqatan yangi yuk (baribir qo'shish)", `force_dup_inv:${pendingId}`)
        .row()
        .text('❌ Bekor qilish', `cancel_i_${pendingId}`);
}
const getDiscountConfirmationKeyboard = (actionId, finalPayable, isCash, currency = 'UZS') => {
    const pendingRef = actionId.replace(/^i_/, '');
    return new grammy_1.InlineKeyboard()
        .text(`✅ Tasdiqlash (${(0, formatters_1.formatCurrency)(finalPayable, currency)})`, `${isCash ? 'confirm_invcash_' : 'confirm_invdebt_'}${actionId}`)
        .row()
        .text("🏷 Skidkani o'zgartirish", `edit_invoice_discount:p_${pendingRef}`)
        .text('❌ Skidkani olib tashlash', `clear_invoice_discount:p_${pendingRef}`)
        .row()
        .text("✏️ Umumiy summani qo'lda kiritish", `edit_invoice_total:p_${pendingRef}`)
        .row()
        .text(`💱 Valyutani o'zgartirish (UZS ↔ USD) [${currency}]`, `toggle_invoice_currency:p_${pendingRef}`)
        .row()
        .text('❌ Bekor qilish', `cancel_${actionId}`);
};
exports.getDiscountConfirmationKeyboard = getDiscountConfirmationKeyboard;
function getSavedInvoiceCardKeyboard(invoiceOrTxId, supplierId, photoFileId, txId) {
    const kb = new grammy_1.InlineKeyboard()
        .text("🏷 Skidkani o'zgartirish", `edit_invoice_discount:${invoiceOrTxId}`)
        .text('❌ Skidkani olib tashlash', `clear_invoice_discount:${invoiceOrTxId}`)
        .row()
        .text("✏️ Umumiy summani qo'lda kiritish", `edit_invoice_total:${invoiceOrTxId}`)
        .row()
        .text("💱 Valyutani o'zgartirish (UZS ↔ USD)", `toggle_invoice_currency:${invoiceOrTxId}`)
        .row();
    if (photoFileId && txId) {
        kb.text("🖼 Asl rasmni ko'rish", `sup:photo:${txId}`).row();
    }
    kb.text("🔙 Cheklar ro'yxatiga qaytish", `sup:receipts:list:${supplierId}:1`).row();
    return kb;
}
function addPaginationRow(kb, currentPage, totalPages, prefix) {
    if (currentPage > 1)
        kb.text('⬅️ Oldingi', `${prefix}${currentPage - 1}`);
    kb.text(`${currentPage}/${totalPages}`, 'ignore');
    if (currentPage < totalPages)
        kb.text('Keyingi ➡️', `${prefix}${currentPage + 1}`);
    return kb.row();
}
function addTwoColButtons(kb, items, getName, getSum, getCb) {
    for (let i = 0; i < items.length; i += 2) {
        for (const item of items.slice(i, i + 2)) {
            const n = (0, transliterate_1.toLatinUz)(getName(item));
            kb.text(`${n.length > 12 ? `${n.slice(0, 12)}...` : n} | ${(0, formatters_1.formatCompactAmount)(getSum(item))}`, getCb(item));
        }
        kb.row();
    }
}
function getDisambiguationKeyboard(candidates, pendingId, selPrefix, newPrefix, cancelPrefix) {
    const kb = new grammy_1.InlineKeyboard();
    candidates.forEach((c, idx) => kb
        .text((0, formatters_1.formatSupplierDebtLine)((0, transliterate_1.toLatinUz)(c.name), c.debtUzs, c.debtUsd, '🏢 '), `${selPrefix}_${pendingId}_${idx}`)
        .row());
    return kb
        .text("➕ Bu yangi ta'minotchi (Alohida ochish)", `${newPrefix}_${pendingId}`)
        .row()
        .text('❌ Bekor qilish', `${cancelPrefix}_${pendingId}`)
        .row();
}
function categoryCodeToCategory(code) {
    if (code === 'C')
        return 'CHEKLAR';
    if (code === 'P')
        return 'PULLAR';
    return 'VOZVRAT';
}
function categoryToCode(category) {
    if (category === 'CHEKLAR')
        return 'C';
    if (category === 'PULLAR')
        return 'P';
    return 'V';
}
function getSupplierCardKeyboard(supplierId) {
    return new grammy_1.InlineKeyboard()
        .text('🧾 Cheklar', `sup:cat:C:${supplierId}:1`)
        .text('💵 Pullar', `sup:cat:P:${supplierId}:1`)
        .row()
        .text('🔄 Vozvrat', `sup:ret:${supplierId}`)
        .text('📄 Tarix (PDF)', `sup:pdf:${supplierId}`)
        .row()
        .text('📦 Yuk olish', `sup:goods:${supplierId}`)
        .text("💸 To'lov qilish", `sup:pay:${supplierId}`)
        .row()
        .text("✏️ Nomini o'zgartirish", `edit_supplier_name:${supplierId}`)
        .text('🛑 Arxivlash', `sup:archive:${supplierId}`)
        .row()
        .text('⬅️ Orqaga', 'sup:p:1');
}
function getSupplierCategoryListKeyboard(supplierId, catCode, items, page, totalPages, formatShortDate) {
    const kb = new grammy_1.InlineKeyboard();
    const icon = catCode === 'C' ? '🧾' : catCode === 'P' ? '💵' : '🔄';
    for (const item of items) {
        const dt = formatShortDate(item.date);
        const amt = (0, formatters_1.formatCompactAmount)(Number(item.amount), item.currency);
        const shortNote = item.note ? ` • ${(0, transliterate_1.toLatinUz)(item.note).slice(0, 14)}` : '';
        kb.text(`${icon} ${dt} | ${amt}${shortNote}`, `sup:rec:${catCode}:${item.id}`).row();
    }
    if (totalPages > 1) {
        addPaginationRow(kb, page, totalPages, `sup:cat:${catCode}:${supplierId}:`);
    }
    if (catCode === 'C') {
        kb.text('📦 Yangi yuk', `sup:goods:${supplierId}`);
    }
    else if (catCode === 'P') {
        kb.text("💸 Yangi to'lov", `sup:pay:${supplierId}`);
    }
    else {
        kb.text('🔄 Yangi vozvrat', `sup:ret:${supplierId}`);
    }
    kb.text('🔙 Orqaga', `sup:v:${supplierId}`).row();
    return kb;
}
function getSupplierRecordDetailKeyboard(catCode, recordId, supplierId, photoFileId) {
    const kb = new grammy_1.InlineKeyboard()
        .text('✏️ Tahrirlash', `sup:ed:${catCode}:${recordId}`)
        .text("🗑 O'chirish", `sup:del:${catCode}:${recordId}`)
        .row();
    if (catCode === 'C' && photoFileId) {
        kb.text("🖼 Asl rasmni ko'rish", `sup:photo:${recordId}`).row();
    }
    kb.text('🔙 Orqaga', `sup:cat:${catCode}:${supplierId}:1`).row();
    return kb;
}
function getSupplierRecordDeleteConfirmKeyboard(catCode, recordId) {
    return new grammy_1.InlineKeyboard()
        .text("✅ Ha, o'chirish", `sup:delok:${catCode}:${recordId}`)
        .text('❌ Bekor qilish', `sup:rec:${catCode}:${recordId}`);
}
function getSupplierReturnCurrencyKeyboard(supplierId) {
    return new grammy_1.InlineKeyboard()
        .text("🇺🇿 So'm (UZS)", `sup:retc:UZS:${supplierId}`)
        .text('💵 Dollar (USD)', `sup:retc:USD:${supplierId}`)
        .row()
        .text('📋 Vozvratlar tarixi', `sup:cat:V:${supplierId}:1`)
        .row()
        .text('🔙 Orqaga', `sup:v:${supplierId}`);
}
function getOnboardingCarouselKeyboard(slideIndex) {
    const kb = new grammy_1.InlineKeyboard();
    if (slideIndex === 1) {
        return kb.text('Keyingisi (2/4) ➡️', 'onb_slide:2');
    }
    if (slideIndex === 2) {
        return kb.text('⬅️ Oldingi', 'onb_slide:1').text('Keyingisi (3/4) ➡️', 'onb_slide:3');
    }
    if (slideIndex === 3) {
        return kb.text('⬅️ Oldingi', 'onb_slide:2').text('Keyingisi (4/4) ➡️', 'onb_slide:4');
    }
    return kb.text('⬅️ Oldingi', 'onb_slide:3').text('🚀 Ishni boshlash', 'onb_finish');
}
