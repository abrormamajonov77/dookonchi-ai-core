"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMenuButton = exports.SYSTEM_MENU_BUTTONS = void 0;
exports.getMainMenu = getMainMenu;
exports.getPendingRegistrationKeyboard = getPendingRegistrationKeyboard;
const grammy_1 = require("grammy");
exports.SYSTEM_MENU_BUTTONS = [
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
const isMenuButton = (text) => exports.SYSTEM_MENU_BUTTONS.some((btn) => text.includes(btn));
exports.isMenuButton = isMenuButton;
function getMainMenu(role = 'STORE_OWNER') {
    const kb = new grammy_1.Keyboard()
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
function getPendingRegistrationKeyboard() {
    return new grammy_1.Keyboard()
        .resized()
        .oneTime()
        .requestContact("📲 Telefon raqamni yuborish (Ro'yxatdan o'tish)");
}
