"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMenuButton = exports.SYSTEM_MENU_BUTTONS = void 0;
exports.getDashboardWebAppUrl = getDashboardWebAppUrl;
exports.getMainMenu = getMainMenu;
exports.getPendingRegistrationKeyboard = getPendingRegistrationKeyboard;
const grammy_1 = require("grammy");
exports.SYSTEM_MENU_BUTTONS = [
    '📊 Dashboard',
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
/**
 * Resolves the public HTTPS URL for the CEO Telegram Mini App Dashboard.
 * Checks APP_URL, RENDER_EXTERNAL_URL, and KOYEB_PUBLIC_DOMAIN.
 * Returns null if unset or non-HTTPS so Telegram Bot API never rejects Keyboard.webApp().
 */
function getDashboardWebAppUrl(rawEnv = process.env) {
    const candidates = [
        rawEnv.APP_URL?.trim(),
        rawEnv.RENDER_EXTERNAL_URL?.trim(),
        rawEnv.KOYEB_PUBLIC_DOMAIN?.trim()
            ? rawEnv.KOYEB_PUBLIC_DOMAIN.trim().startsWith('http')
                ? rawEnv.KOYEB_PUBLIC_DOMAIN.trim()
                : `https://${rawEnv.KOYEB_PUBLIC_DOMAIN.trim()}`
            : undefined,
    ];
    for (const raw of candidates) {
        if (!raw)
            continue;
        try {
            const parsed = new URL(raw);
            if (parsed.protocol !== 'https:')
                continue;
            const cleanPath = parsed.pathname.replace(/\/+$/, '');
            const targetPath = cleanPath.endsWith('/dashboard') ? cleanPath : `${cleanPath}/dashboard`;
            return `${parsed.origin}${targetPath}`;
        }
        catch {
            continue;
        }
    }
    return null;
}
function getMainMenu(role = 'STORE_OWNER', rawEnv = process.env) {
    const kb = new grammy_1.Keyboard().resized();
    const dashboardUrl = getDashboardWebAppUrl(rawEnv);
    if (dashboardUrl) {
        kb.webApp('📊 Dashboard', dashboardUrl).row();
    }
    kb.text('📊 Z-Hisobot (Kunlik)')
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
