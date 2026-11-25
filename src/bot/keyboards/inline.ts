import { InlineKeyboard } from 'grammy';
import { formatCurrency, formatCompactAmount, formatSupplierDebtLine } from '../../utils/formatters';
import { toLatinUz } from '../../utils/transliterate';
import {
  CASH_SOURCE_BTN_CANCEL,
  CASH_SOURCE_BTN_SAFE,
  CASH_SOURCE_BTN_TODAY,
} from '../../utils/cash-source';

export function getConfirmationKeyboard(actionId: string, copyTextContent?: string) {
  const kb = new InlineKeyboard();
  if (copyTextContent) kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
  return kb.text('✅ Tasdiqlash', `confirm_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);
}

/**
 * Mandatory Cash Source Selection Keyboard for Cash Goods Purchases (Today's Register vs. Safe)
 */
export function getCashSourceSelectionKeyboard(actionId: string, editCb?: string) {
  const kb = new InlineKeyboard()
    .text(CASH_SOURCE_BTN_TODAY, `cs:T:${actionId}`)
    .row()
    .text(CASH_SOURCE_BTN_SAFE, `cs:S:${actionId}`)
    .row();
  if (editCb) {
    return kb.text('✏️ Tahrirlash', editCb).text(CASH_SOURCE_BTN_CANCEL, `cancel_${actionId}`);
  }
  return kb.text(CASH_SOURCE_BTN_CANCEL, `cancel_${actionId}`);
}

/**
 * MODUL 5.2: 1-Click Payment Source Selection for Supplier Payments
 */
export function getPaymentSourceConfirmationKeyboard(actionId: string) {
  return new InlineKeyboard()
    .text('💵 Bugungi kassadan (Z-otchyotga kiradi)', `ps:T:${actionId}`)
    .row()
    .text('🏦 Kechagi puldan / Seyfdan (Z-otchyotga kirmaydi)', `ps:S:${actionId}`)
    .row()
    .text('❌ Bekor qilish', `cancel_${actionId}`);
}

/**
 * MODUL 4.2: Fuzzy Supplier Typo Guard Keyboard ("Dinar" vs "Diner")
 */
export function getFuzzySupplierSuggestionKeyboard(
  _existingSupplierId: string,
  existingSupplierName: string,
  inputName: string,
  actionId: string
) {
  const cleanExisting = toLatinUz(existingSupplierName).slice(0, 28);
  const cleanInput = toLatinUz(inputName).slice(0, 28);
  return new InlineKeyboard()
    .text(`✅ Ha, "${cleanExisting}" ga qo'shish`, `sf_use:${actionId}`)
    .row()
    .text(`➕ Yo'q, "${cleanInput}" deb yangi ochish`, `sf_new:${actionId}`)
    .row()
    .text('❌ Bekor qilish', `sf_no:${actionId}`);
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
    .text("💱 Valyutani o'zgartirish (UZS ↔ USD)", `toggle_invoice_currency:${invoiceOrTxId}`)
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
      const n = toLatinUz(getName(item));
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
      .text(formatSupplierDebtLine(toLatinUz(c.name), c.debtUzs, c.debtUsd, '🏢 '), `${selPrefix}_${pendingId}_${idx}`)
      .row()
  );
  return kb
    .text("➕ Bu yangi ta'minotchi (Alohida ochish)", `${newPrefix}_${pendingId}`)
    .row()
    .text('❌ Bekor qilish', `${cancelPrefix}_${pendingId}`)
    .row();
}

export type SupplierCategoryCode = 'C' | 'P' | 'V';

export function categoryCodeToCategory(code: string): 'CHEKLAR' | 'PULLAR' | 'VOZVRAT' {
  if (code === 'C') return 'CHEKLAR';
  if (code === 'P') return 'PULLAR';
  return 'VOZVRAT';
}

export function categoryToCode(category: 'CHEKLAR' | 'PULLAR' | 'VOZVRAT'): SupplierCategoryCode {
  if (category === 'CHEKLAR') return 'C';
  if (category === 'PULLAR') return 'P';
  return 'V';
}

export function getSupplierCardKeyboard(supplierId: string) {
  return new InlineKeyboard()
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

export function getSupplierCategoryListKeyboard(
  supplierId: string,
  catCode: SupplierCategoryCode,
  items: Array<{ id: string; date: Date; amount: number; currency: 'UZS' | 'USD'; note?: string }>,
  page: number,
  totalPages: number,
  formatShortDate: (d: Date) => string
) {
  const kb = new InlineKeyboard();
  const icon = catCode === 'C' ? '🧾' : catCode === 'P' ? '💵' : '🔄';

  for (const item of items) {
    const dt = formatShortDate(item.date);
    const amt = formatCompactAmount(Number(item.amount), item.currency);
    const shortNote = item.note ? ` • ${toLatinUz(item.note).slice(0, 14)}` : '';
    kb.text(`${icon} ${dt} | ${amt}${shortNote}`, `sup:rec:${catCode}:${item.id}`).row();
  }

  if (totalPages > 1) {
    addPaginationRow(kb, page, totalPages, `sup:cat:${catCode}:${supplierId}:`);
  }

  if (catCode === 'C') {
    kb.text('📦 Yangi yuk', `sup:goods:${supplierId}`);
  } else if (catCode === 'P') {
    kb.text("💸 Yangi to'lov", `sup:pay:${supplierId}`);
  } else {
    kb.text('🔄 Yangi vozvrat', `sup:ret:${supplierId}`);
  }

  kb.text('🔙 Orqaga', `sup:v:${supplierId}`).row();
  return kb;
}

export function getSupplierRecordDetailKeyboard(
  catCode: SupplierCategoryCode,
  recordId: string,
  supplierId: string,
  photoFileId?: string | null
) {
  const kb = new InlineKeyboard()
    .text('✏️ Tahrirlash', `sup:ed:${catCode}:${recordId}`)
    .text("🗑 O'chirish", `sup:del:${catCode}:${recordId}`)
    .row();

  if (catCode === 'C' && photoFileId) {
    kb.text("🖼 Asl rasmni ko'rish", `sup:photo:${recordId}`).row();
  }

  kb.text('🔙 Orqaga', `sup:cat:${catCode}:${supplierId}:1`).row();
  return kb;
}

export function getSupplierRecordDeleteConfirmKeyboard(
  catCode: SupplierCategoryCode,
  recordId: string
) {
  return new InlineKeyboard()
    .text("✅ Ha, o'chirish", `sup:delok:${catCode}:${recordId}`)
    .text('❌ Bekor qilish', `sup:rec:${catCode}:${recordId}`);
}

export function getSupplierReturnCurrencyKeyboard(supplierId: string) {
  return new InlineKeyboard()
    .text("🇺🇿 So'm (UZS)", `sup:retc:UZS:${supplierId}`)
    .text('💵 Dollar (USD)', `sup:retc:USD:${supplierId}`)
    .row()
    .text('📋 Vozvratlar tarixi', `sup:cat:V:${supplierId}:1`)
    .row()
    .text('🔙 Orqaga', `sup:v:${supplierId}`);
}

export function getOnboardingCarouselKeyboard(slideIndex: 1 | 2 | 3 | 4): InlineKeyboard {
  const kb = new InlineKeyboard();
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
