import { Keyboard } from 'grammy';

export const SYSTEM_MENU_BUTTONS = [
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

export const isMenuButton = (text: string) => SYSTEM_MENU_BUTTONS.some((btn) => text.includes(btn));

/**
 * Resolves the public HTTPS URL for the CEO Telegram Mini App Dashboard.
 * Checks APP_URL, RENDER_EXTERNAL_URL, and KOYEB_PUBLIC_DOMAIN.
 * Returns null if unset or non-HTTPS so Telegram Bot API never rejects Keyboard.webApp().
 */
export function getDashboardWebAppUrl(
  rawEnv: Record<string, string | undefined> = process.env
): string | null {
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
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') continue;
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      const targetPath = cleanPath.endsWith('/dashboard') ? cleanPath : `${cleanPath}/dashboard`;
      return `${parsed.origin}${targetPath}`;
    } catch {
      continue;
    }
  }
  return null;
}

export function getMainMenu(
  role: string = 'STORE_OWNER',
  rawEnv: Record<string, string | undefined> = process.env
) {
  const kb = new Keyboard().resized();

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

export function getPendingRegistrationKeyboard() {
  return new Keyboard()
    .resized()
    .oneTime()
    .requestContact("📲 Telefon raqamni yuborish (Ro'yxatdan o'tish)");
}
