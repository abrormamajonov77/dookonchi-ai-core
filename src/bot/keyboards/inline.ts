import { InlineKeyboard } from 'grammy';
import { formatCurrency, formatCompactAmount, formatSupplierDebtLine } from '../../utils/formatters';

export function getConfirmationKeyboard(actionId: string, copyTextContent?: string) {
  const kb = new InlineKeyboard();
  if (copyTextContent) kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
  return kb.text('✅ Tasdiqlash', `confirm_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);
}

export const getTemplateConfirmKeyboard = (editCb: string, actionId: string) =>
  new InlineKeyboard()
    .text('✏️ Tahrirlash', editCb)
    .row()
    .text('✅ Tasdiqlash', `confirm_${actionId}`)
    .text('❌ Bekor qilish', `cancel_${actionId}`);

export function getInvoiceConfirmationKeyboard(
  actionId: string,
  copyTextContent?: string,
  currency: 'UZS' | 'USD' = 'UZS'
) {
  const pendingRef = actionId.replace(/^i_/, '');
  const kb = new InlineKeyboard();
  if (copyTextContent) kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
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

export function getDuplicateInvoiceWarningKeyboard(pendingId: string) {
  return new InlineKeyboard()
    .text("⚠️ Bu haqiqatan yangi yuk (baribir qo'shish)", `force_dup_inv:${pendingId}`)
    .row()
    .text('❌ Bekor qilish', `cancel_i_${pendingId}`);
}

export const getDiscountConfirmationKeyboard = (
  actionId: string,
  finalPayable: number,
  isCash: boolean,
  currency: 'UZS' | 'USD' = 'UZS'
) => {
  const pendingRef = actionId.replace(/^i_/, '');
  return new InlineKeyboard()
    .text(
      `✅ Tasdiqlash (${formatCurrency(finalPayable, currency)})`,
      `${isCash ? 'confirm_invcash_' : 'confirm_invdebt_'}${actionId}`
    )
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

export function getSavedInvoiceCardKeyboard(
  invoiceOrTxId: string,
  supplierId: string,
  photoFileId?: string | null,
  txId?: string
) {
  const kb = new InlineKeyboard()
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

export function addPaginationRow(kb: InlineKeyboard, currentPage: number, totalPages: number, prefix: string) {
  if (currentPage > 1) kb.text('⬅️ Oldingi', `${prefix}${currentPage - 1}`);
  kb.text(`${currentPage}/${totalPages}`, 'ignore');
  if (currentPage < totalPages) kb.text('Keyingi ➡️', `${prefix}${currentPage + 1}`);
  return kb.row();
}

export function addTwoColButtons<T>(
  kb: InlineKeyboard,
  items: T[],
  getName: (x: T) => string,
  getSum: (x: T) => number,
  getCb: (x: T) => string
) {
  for (let i = 0; i < items.length; i += 2) {
    for (const item of items.slice(i, i + 2)) {
      const n = getName(item);
      kb.text(`${n.length > 12 ? `${n.slice(0, 12)}...` : n} | ${formatCompactAmount(getSum(item))}`, getCb(item));
    }
    kb.row();
  }
}

export function getDisambiguationKeyboard(
  candidates: any[],
  pendingId: string,
  selPrefix: string,
  newPrefix: string,
  cancelPrefix: string
) {
  const kb = new InlineKeyboard();
  candidates.forEach((c, idx) =>
    kb
      .text(formatSupplierDebtLine(c.name, c.debtUzs, c.debtUsd, '🏢 '), `${selPrefix}_${pendingId}_${idx}`)
      .row()
  );
  return kb
    .text("➕ Bu yangi ta'minotchi (Alohida ochish)", `${newPrefix}_${pendingId}`)
    .row()
    .text('❌ Bekor qilish', `${cancelPrefix}_${pendingId}`)
    .row();
}
