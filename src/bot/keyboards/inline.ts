import { InlineKeyboard } from 'grammy';

export function getConfirmationKeyboard(actionId: string, copyTextContent?: string) {
  const keyboard = new InlineKeyboard();
  
  if (copyTextContent) {
    keyboard.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
  }
  
  keyboard.text('✅ Tasdiqlash', `confirm_${actionId}`)
          .text('❌ Bekor qilish', `cancel_${actionId}`);
          
  return keyboard;
}

export function getInvoiceConfirmationKeyboard(actionId: string, copyTextContent?: string) {
  const keyboard = new InlineKeyboard();
  
  if (copyTextContent) {
    keyboard.switchInlineCurrent('✏️ Tahrirlash', copyTextContent).row();
  }
  
  keyboard.text('🎁 Skidka kiritish', `add_discount_${actionId}`).row();

  keyboard.text('📦 Nasiyaga (Qarzimizga yozish)', `confirm_invdebt_${actionId}`)
          .row()
          .text('💵 Naqdga (Faqat naqd arxiviga)', `confirm_invcash_${actionId}`)
          .row()
          .text('❌ Bekor qilish', `cancel_${actionId}`);
          
  return keyboard;
}

export function getDiscountConfirmationKeyboard(actionId: string, finalPayable: number, isCash: boolean) {
  const keyboard = new InlineKeyboard();
  const confirmAction = isCash ? `confirm_invcash_${actionId}` : `confirm_invdebt_${actionId}`;
  keyboard.text(`✅ Tasdiqlash (${finalPayable.toLocaleString('ru-RU')} UZS)`, confirmAction).row();
  keyboard.text('🔄 Skidkani o\'zgartirish', `add_discount_${actionId}`).text('❌ Bekor qilish', `cancel_${actionId}`);
  return keyboard;
}
