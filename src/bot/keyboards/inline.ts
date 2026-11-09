import { InlineKeyboard } from 'grammy';
import { formatMoney, formatCompactAmount } from '../../utils/formatters';

export function getConfirmationKeyboard(actionId: string, copyTextContent?: string) {
  const kb = new InlineKeyboard();
  if (copyTextContent) kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
  return kb.text('✅ Tasdiqlash', `confirm_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);
}

export const getTemplateConfirmKeyboard = (editCb: string, actionId: string) =>
  new InlineKeyboard().text('✏️ Tahrirlash', editCb).row().text('✅ Tasdiqlash', `confirm_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);

export function getInvoiceConfirmationKeyboard(actionId: string, copyTextContent?: string) {
  const kb = new InlineKeyboard();
  if (copyTextContent) kb.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
  return kb
    .text('🎁 Skidka kiritish', `add_discount_${actionId}`).row()
    .text('📦 Nasiyaga (Qarzimizga yozish)', `confirm_invdebt_${actionId}`).row()
    .text('💵 Naqdga (Faqat naqd arxiviga)', `confirm_invcash_${actionId}`).row()
    .text('❌ Bekor qilish', `cancel_${actionId}`);
}

export const getDiscountConfirmationKeyboard = (actionId: string, finalPayable: number, isCash: boolean) =>
  new InlineKeyboard()
    .text(`✅ Tasdiqlash (${finalPayable.toLocaleString('ru-RU')} UZS)`, `${isCash ? 'confirm_invcash_' : 'confirm_invdebt_'}${actionId}`).row()
    .text("🔄 Skidkani o'zgartirish", `add_discount_${actionId}`)
    .text('❌ Bekor qilish', `cancel_${actionId}`);

export function addPaginationRow(kb: InlineKeyboard, currentPage: number, totalPages: number, prefix: string) {
  if (currentPage > 1) kb.text('⬅️ Oldingi', `${prefix}${currentPage - 1}`);
  kb.text(`${currentPage}/${totalPages}`, 'ignore');
  if (currentPage < totalPages) kb.text('Keyingi ➡️', `${prefix}${currentPage + 1}`);
  return kb.row();
}

export function addTwoColButtons<T>(kb: InlineKeyboard, items: T[], getName: (x: T) => string, getSum: (x: T) => number, getCb: (x: T) => string) {
  for (let i = 0; i < items.length; i += 2) {
    for (const item of items.slice(i, i + 2)) {
      const n = getName(item);
      kb.text(`${n.length > 12 ? `${n.slice(0, 12)}...` : n} | ${formatCompactAmount(getSum(item))}`, getCb(item));
    }
    kb.row();
  }
}

export function getDisambiguationKeyboard(candidates: any[], pendingId: string, selPrefix: string, newPrefix: string, cancelPrefix: string) {
  const kb = new InlineKeyboard();
  candidates.forEach((c, idx) => kb.text(`🏢 ${c.name} - ${formatMoney(Number(c.debtUzs), 'UZS')}`, `${selPrefix}_${pendingId}_${idx}`).row());
  return kb.text("➕ Bu yangi ta'minotchi (Alohida ochish)", `${newPrefix}_${pendingId}`).row().text('❌ Bekor qilish', `${cancelPrefix}_${pendingId}`).row();
}
