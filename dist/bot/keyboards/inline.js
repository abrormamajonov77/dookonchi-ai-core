"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDiscountConfirmationKeyboard = exports.getTemplateConfirmKeyboard = void 0;
exports.getConfirmationKeyboard = getConfirmationKeyboard;
exports.getInvoiceConfirmationKeyboard = getInvoiceConfirmationKeyboard;
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
const getTemplateConfirmKeyboard = (editCb, actionId) => new grammy_1.InlineKeyboard().text('✏️ Tahrirlash', editCb).row().text('✅ Tasdiqlash', `confirm_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);
exports.getTemplateConfirmKeyboard = getTemplateConfirmKeyboard;
function getInvoiceConfirmationKeyboard(actionId, copyTextContent) {
    const kb = new grammy_1.InlineKeyboard();
    if (copyTextContent)
        kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
    return kb
        .text('🎁 Skidka kiritish', `add_discount_${actionId}`).row()
        .text('📦 Nasiyaga (Qarzimizga yozish)', `confirm_invdebt_${actionId}`).row()
        .text('💵 Naqdga (Faqat naqd arxiviga)', `confirm_invcash_${actionId}`).row()
        .text('❌ Bekor qilish', `cancel_${actionId}`);
}
const getDiscountConfirmationKeyboard = (actionId, finalPayable, isCash) => new grammy_1.InlineKeyboard()
    .text(`✅ Tasdiqlash (${finalPayable.toLocaleString('ru-RU')} UZS)`, `${isCash ? 'confirm_invcash_' : 'confirm_invdebt_'}${actionId}`).row()
    .text("🔄 Skidkani o'zgartirish", `add_discount_${actionId}`)
    .text('❌ Bekor qilish', `cancel_${actionId}`);
exports.getDiscountConfirmationKeyboard = getDiscountConfirmationKeyboard;
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
    candidates.forEach((c, idx) => kb.text(`🏢 ${c.name} - ${(0, formatters_1.formatMoney)(Number(c.debtUzs), 'UZS')}`, `${selPrefix}_${pendingId}_${idx}`).row());
    return kb.text("➕ Bu yangi ta'minotchi (Alohida ochish)", `${newPrefix}_${pendingId}`).row().text('❌ Bekor qilish', `${cancelPrefix}_${pendingId}`).row();
}
