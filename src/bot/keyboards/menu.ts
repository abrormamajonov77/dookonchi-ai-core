import { Keyboard } from 'grammy';

export const SYSTEM_MENU_BUTTONS = [
  "📦 Ta'minotchilar",
  '👥 Nasiyadorlar',
  '💵 Naqd',
  '📉 Xarajatlar',
  '📊 Z-Hisobot (Kunlik)',
  '📈 Davriy Hisobot',
  '📝 Qidiruv',
  '➕ Nakladnoy',
  '📥 Bazani yuklab olish (Excel / PDF)',
  '👑 Admin Panel',
  '/start',
  '/admin',
  '/report',
  '/hisobot',
];

export const isMenuButton = (text: string) => SYSTEM_MENU_BUTTONS.some((btn) => text.includes(btn));

export function getMainMenu(role: string = 'STORE_OWNER') {
  const kb = new Keyboard()
    .resized()
    .text('📊 Z-Hisobot (Kunlik)')
    .text('📈 Davriy Hisobot')
    .row()
    .text('💵 Naqd')
    .text('📉 Xarajatlar')
    .row()
    .text('👥 Nasiyadorlar')
    .text("📦 Ta'minotchilar")
    .row()
    .text('📝 Qidiruv')
    .text('➕ Nakladnoy')
    .row()
    .text('📥 Bazani yuklab olish (Excel / PDF)');

  if (role === 'SUPER_ADMIN') {
    kb.row().text('👑 Admin Panel');
  }
  return kb;
}

export function getPendingRegistrationKeyboard() {
  return new Keyboard()
    .resized()
    .oneTime()
    .requestContact("📲 Telefon raqamni yuborish (Ro'yxatdan o'tish)");
}
