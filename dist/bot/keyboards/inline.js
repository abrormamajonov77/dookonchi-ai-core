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
        .text('💵 Bugungi kassadan (Z-otchyotga kiradi)', `pay_source:TODAY_CASH:${actionId}`)
        .row()
        .text('🏦 Kechagi puldan / Seyfdan (Z-otchyotga kirmaydi)', `pay_source:PREVIOUS_SAFE:${actionId}`)
        .row()
        .text('❌ Bekor qilish', `cancel_${actionId}`);
}
/**
 * MODUL 4.2: Fuzzy Supplier Typo Guard Keyboard ("Dinar" vs "Diner")
 */
function getFuzzySupplierSuggestionKeyboard(existingSupplierId, existingSupplierName, inputName, actionId) {
    const cleanExisting = (0, transliterate_1.toLatinUz)(existingSupplierName);
    const cleanInput = (0, transliterate_1.toLatinUz)(inputName);
    return new grammy_1.InlineKeyboard()
        .text(`✅ Ha, "${cleanExisting}" ga qo'shish`, `sup_fuzzy_use:${existingSupplierId}:${actionId}`)
        .row()
        .text(`➕ Yo'q, "${cleanInput}" deb yangi ochish`, `sup_fuzzy_new:${actionId}`)
        .row()
        .text('❌ Bekor qilish', `sup_fuzzy_cancel:${actionId}`);
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
