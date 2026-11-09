import { Keyboard } from 'grammy';
import { UserRole } from '@prisma/client';

export const SYSTEM_MENU_BUTTONS = ["📦 Ta'minotchilar", '👥 Nasiyadorlar', '💵 Naqd', '📉 Xarajatlar', '📊 Z-Hisobot (Kunlik)', '📈 Davriy Hisobot', '📝 Qidiruv', '➕ Nakladnoy', '/start', '/report', '/hisobot'];
export const isMenuButton = (text: string) => SYSTEM_MENU_BUTTONS.some(btn => text.includes(btn));

export function getMainMenu(role: UserRole) {
  const kb = new Keyboard().resized();
  return role === 'OWNER'
    ? kb.text('📊 Z-Hisobot (Kunlik)').text('📈 Davriy Hisobot').row().text('💵 Naqd').text('📉 Xarajatlar').row().text('👥 Nasiyadorlar').text("📦 Ta'minotchilar").row().text('📝 Qidiruv').row()
    : kb.text('📝 Qidiruv').text('➕ Nakladnoy').row();
}
