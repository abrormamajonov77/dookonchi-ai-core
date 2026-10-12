import { Keyboard } from 'grammy';
import { UserRole } from '@prisma/client';

export function getMainMenu(role: UserRole) {
  const keyboard = new Keyboard().resized();

  if (role === 'OWNER') {
    keyboard
      .text('📊 Z-Hisobot (Kunlik)')
      .text('📉 Xarajatlar')
      .row()
      .text('💵 Naqd')
      .text('👥 Nasiyadorlar')
      .text("📦 Ta'minotchilar")
      .row()
      .text('📝 Qidiruv')
      .row();
  } else {
    // Seller
    keyboard
      .text('📝 Qidiruv')
      .text('➕ Nakladnoy')
      .row();
  }

  return keyboard;
}
