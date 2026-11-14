"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDiscountConfirmationKeyboard = exports.getTemplateConfirmKeyboard = void 0;
exports.getConfirmationKeyboard = getConfirmationKeyboard;
exports.getInvoiceConfirmationKeyboard = getInvoiceConfirmationKeyboard;
exports.getSavedInvoiceCardKeyboard = getSavedInvoiceCardKeyboard;
exports.addPaginationRow = addPaginationRow;
exports.addTwoColButtons = addTwoColButtons;
exports.getDisambiguationKeyboard = getDisambiguationKeyboard;
const grammy_1 = require("grammy");
const formatters_1 = require("../../utils/formatters");
function getConfirmationKeyboard(actionId, copyTextContent) {
    const kb = new grammy_1.InlineKeyboard();
    if (copyTextContent)
        kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
    return kb.text('✅ Tasdiqlash', `confirm_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);
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
        .text('📦 Nasiyaga (Qarzimizga yozish)', `confirm_invdebt_${actionId}`)
        .row()
        .text('💵 Naqdga (Faqat naqd arxiviga)', `confirm_invcash_${actionId}`)
        .row()
        .text('❌ Bekor qilish', `cancel_${actionId}`);
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
        .text('💱 Valyutani o\'zgartirish (UZS ↔ USD)', `toggle_invoice_currency:${invoiceOrTxId}`)
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
            const n = getName(item);
            kb.text(`${n.length > 12 ? `${n.slice(0, 12)}...` : n} | ${(0, formatters_1.formatCompactAmount)(getSum(item))}`, getCb(item));
        }
        kb.row();
    }
}
function getDisambiguationKeyboard(candidates, pendingId, selPrefix, newPrefix, cancelPrefix) {
    const kb = new grammy_1.InlineKeyboard();
    candidates.forEach((c, idx) => kb
        .text((0, formatters_1.formatSupplierDebtLine)(c.name, c.debtUzs, c.debtUsd, '🏢 '), `${selPrefix}_${pendingId}_${idx}`)
        .row());
    return kb
        .text("➕ Bu yangi ta'minotchi (Alohida ochish)", `${newPrefix}_${pendingId}`)
        .row()
        .text('❌ Bekor qilish', `${cancelPrefix}_${pendingId}`)
        .row();
}
