"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMenuButton = exports.SYSTEM_MENU_BUTTONS = void 0;
exports.getMainMenu = getMainMenu;
const grammy_1 = require("grammy");
exports.SYSTEM_MENU_BUTTONS = ["📦 Ta'minotchilar", '👥 Nasiyadorlar', '💵 Naqd', '📉 Xarajatlar', '📊 Z-Hisobot (Kunlik)', '📈 Davriy Hisobot', '📝 Qidiruv', '➕ Nakladnoy', '/start', '/report', '/hisobot'];
const isMenuButton = (text) => exports.SYSTEM_MENU_BUTTONS.some(btn => text.includes(btn));
exports.isMenuButton = isMenuButton;
function getMainMenu(role) {
    const kb = new grammy_1.Keyboard().resized();
    return role === 'OWNER'
        ? kb.text('📊 Z-Hisobot (Kunlik)').text('📈 Davriy Hisobot').row().text('💵 Naqd').text('📉 Xarajatlar').row().text('👥 Nasiyadorlar').text("📦 Ta'minotchilar").row().text('📝 Qidiruv').row()
        : kb.text('📝 Qidiruv').text('➕ Nakladnoy').row();
}
