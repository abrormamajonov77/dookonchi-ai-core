import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { env } from '../../config/env';
import { SubscriptionService, parseSubscriptionDuration } from '../../services/subscription.service';
import {
  clearOnboardingMedia,
  getOnboardingMedia,
  OnboardingSlideIndex,
  OnboardingUploadTarget,
  setOnboardingIntroVideo,
  setOnboardingSlideMedia,
} from '../../services/onboarding.service';
import { sendOnboardingCarousel } from './start';
import { formatDate, formatDateShort, formatSom, parseSmartAmount } from '../../utils/formatters';
import { clearSession, replyOrEdit, safeReply, sanitizeMdV1 } from '../../utils/telegram';
import { addPaginationRow } from '../keyboards/inline';
import { isMenuButton } from '../keyboards/menu';

export const adminHandler = new Composer<MyContext>();

function ensureSuperAdmin(ctx: MyContext): boolean {
  if (!ctx.from) return false;
  return SubscriptionService.isSuperAdmin(ctx.from.id);
}

function getStatusBadge(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return '🟢 Faol';
    case 'PENDING':
      return '⏳ Kutmoqda';
    case 'EXPIRED':
      return '⌛️ Tugagan';
    case 'PAUSED':
      return "⏸ To'xtatilgan";
    case 'BLOCKED':
      return '⛔️ Bloklangan';
    default:
      return status;
  }
}

function getRemainingDaysText(expiresAt?: Date | null): string {
  if (!expiresAt) return "Muddat yo'q";
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Muddati tugagan';
  if (days > 3650) return 'Cheksiz';
  return `📅 ${days} kun qoldi`;
}

export function getAdminMainPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Obunachilar ro'yxati va Boshqaruv", 'adm:users:1')
    .row()
    .text("⏳ Yangi so'rovlar va To'lov cheklari", 'adm:pending')
    .row()
    .text('💳 Karta va Obuna narxini sozlash', 'adm:settings')
    .row()
    .text('🎬 Yo‘riqnoma media', 'adm:onb_media')
    .row()
    .text('💬 Mijozga shaxsiy xabar yozish', 'adm:dm_list:1')
    .row()
    .text("📢 Umumiy E'lon yuborish (Rassilka)", 'adm:broadcast')
    .row()
    .text('📊 SaaS Daromad va Statistika', 'adm:stats')
    .row()
    .text('🔙 Asosiy menyu', 'menu:main');
}

async function showAdminMainPanel(ctx: MyContext, isEdit = false) {
  if (!ensureSuperAdmin(ctx)) return;
  const stats = await SubscriptionService.getSaasStatistics();
  const text =
    `👑 **SMARTBAQQOL SAAS — SUPER-ADMIN PANELI**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 Jami mijozlar: **${stats.totalUsers} ta** | 🟢 Faol: **${stats.activeUsers} ta**\n` +
    `⏳ Yangi so'rovlar: **${stats.pendingUsers} ta** | 🧾 Cheklar: **${stats.pendingPaymentsCount} ta**\n` +
    `💰 Shu oylik daromad: **${formatSom(stats.monthlyRevenueUzs)}**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Quyidagi boshqaruv bo'limlaridan birini tanlang:`;

  await replyOrEdit(ctx, text, getAdminMainPanelKeyboard(), isEdit);
}

adminHandler.hears('👑 Admin Panel', async (ctx) => {
  clearSession(ctx);
  await showAdminMainPanel(ctx, false);
});

adminHandler.command('admin', async (ctx) => {
  clearSession(ctx);
  await showAdminMainPanel(ctx, false);
});

adminHandler.callbackQuery('adm:panel', async (ctx) => {
  clearSession(ctx);
  await showAdminMainPanel(ctx, true);
});

// ============================================================================
// 1. 👥 Obunachilar ro'yxati va Boshqaruv
// ============================================================================
async function showSubscribersList(ctx: MyContext, page = 1, isEdit = true) {
  if (!ensureSuperAdmin(ctx)) return;
  const PER_PAGE = 8;
  const users = await prisma.user.findMany({
    where: { telegramId: { not: env.OWNER_TELEGRAM_ID } },
    orderBy: { createdAt: 'desc' },
  });

  const totalPages = Math.ceil(users.length / PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const slice = users.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const kb = new InlineKeyboard();
  const lines: string[] = [];

  for (const u of slice) {
    const rawName = u.fullName || u.name || "Noma'lum";
    const safeName = sanitizeMdV1(rawName);
    const badge = getStatusBadge(u.status);
    const rem = getRemainingDaysText(u.subscriptionExpiresAt);
    lines.push(`• **${safeName}** (\`${u.telegramId}\`) — ${badge} (${rem})`);
    kb.text(`${badge} ${rawName.slice(0, 16)} (${rem})`, `adm:user:${u.telegramId}`).row();
  }

  addPaginationRow(kb, currentPage, totalPages, 'adm:users:');
  kb.text('🔙 Admin Panelga qaytish', 'adm:panel');

  const text =
    `👥 **Obunachilar ro'yxati va Boshqaruv (Sahifa ${currentPage}/${totalPages})**\n\n` +
    (lines.length ? lines.join('\n') : "Hozircha mijozlar yo'q.") +
    `\n\nBoshqarish uchun mijoz ustiga bosing:`;

  await replyOrEdit(ctx, text, kb, isEdit);
}

adminHandler.callbackQuery(/^adm:users:(\d+)$/, async (ctx) => {
  await showSubscribersList(ctx, parseInt(ctx.match[1], 10) || 1, true);
});

export async function showSubscriberDetail(ctx: MyContext, telegramId: string, isEdit = true) {
  if (!ensureSuperAdmin(ctx)) return;
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return ctx.answerCallbackQuery({ text: 'Foydalanuvchi topilmadi.', show_alert: true });

  const [suppliersCount, invoicesCount] = await Promise.all([
    prisma.supplier.count({ where: { ownerId: telegramId, isActive: true } }),
    prisma.invoice.count({ where: { ownerId: telegramId } }),
  ]);

  const text =
    `👤 **MIJOZ KARTOCHKASI**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `• **Ismi:** ${sanitizeMdV1(user.fullName || user.name || "Noma'lum")}\n` +
    `• **Telefon:** ${sanitizeMdV1(user.phone || 'Kiritilmagan')}\n` +
    `• **Username:** ${user.username ? `@${sanitizeMdV1(user.username)}` : 'Kiritilmagan'}\n` +
    `• **Telegram ID:** \`${user.telegramId}\`\n` +
    `• **Holati:** ${getStatusBadge(user.status)}\n` +
    `• **Tarif:** ${sanitizeMdV1(user.subscriptionPlan || 'Belgilanmagan')} (Bonus: ${user.bonusDaysGranted || 0} kun)\n` +
    `• **Tugash vaqti:** ${user.subscriptionExpiresAt ? `${formatDateShort(user.subscriptionExpiresAt)} (${getRemainingDaysText(user.subscriptionExpiresAt)})` : "Yo'q"}\n` +
    `• **Shaxsiy bazasi:** ${suppliersCount} ta ta'minotchi | ${invoicesCount} ta nakladnoy\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Tarif qo'shish yoki holatini o'zgartirish:`;

  const kb = new InlineKeyboard()
    .text('✅ +1 Oy (30 kun)', `adm_grant:${telegramId}:30:0:1 Oylik`)
    .text('🎁 +3 Oy + 15k Bonus', `adm_grant:${telegramId}:90:15:3 Oylik`)
    .row()
    .text('🎁 +4 Oy + 1 oy Bonus', `adm_grant:${telegramId}:120:30:4 Oylik`)
    .text('🎁 +6 Oy + 45k Bonus', `adm_grant:${telegramId}:180:45:6 Oylik`)
    .row()
    .text('🔥 +1 Yil + 2 oy Bonus', `adm_grant:${telegramId}:365:60:1 Yillik`)
    .text('🎁 +3 kun Sinov', `adm_grant:${telegramId}:3:0:Sinov`)
    .row()
    .text("✏️ O'zim Oy/Kun va Bonus yozaman", `adm_custom:${telegramId}`)
    .row()
    .text(
      user.status === 'PAUSED' ? '▶️ Faoliyatini qayta yoqish' : "⏸ Vaqtincha to'xtatish",
      user.status === 'PAUSED' ? `adm_unpause:${telegramId}` : `adm_pause:${telegramId}`
    )
    .text('⛔️ Bloklash', `adm_block:${telegramId}`)
    .row()
    .text('💬 Shaxsiy xabar yozish', `adm_msg:${telegramId}`)
    .row()
    .text("🔙 Obunachilar ro'yxatiga", 'adm:users:1');

  await replyOrEdit(ctx, text, kb, isEdit);
}

adminHandler.callbackQuery(/^adm:user:(.+)$/, async (ctx) => {
  await showSubscriberDetail(ctx, ctx.match[1], true);
});

// ============================================================================
// GRANT / CUSTOM / PAUSE / BLOCK CALLBACKS
// ============================================================================
adminHandler.callbackQuery(/^adm_grant:([^:]+):(\d+):(\d+):(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const [, telegramId, rawBase, rawBonus, planName] = ctx.match;
  const baseDays = parseInt(rawBase, 10) || 30;
  const bonusDays = parseInt(rawBonus, 10) || 0;

  const result = await SubscriptionService.grantSubscription({
    telegramId,
    baseDays,
    bonusDays,
    planName,
    sendSms: (targetId, smsText, replyMarkup) =>
      ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => {}),
  });

  await ctx.answerCallbackQuery({
    text: `✅ Ruxsat berildi! (${result.totalDays} kun). Mijozga Bot-SMS yuborildi!`,
  });

  const confirmText =
    `✅ **Mijozga ruxsat berildi va avtomatik Bot-SMS yuborildi!**\n\n` +
    `👤 Mijoz: **${sanitizeMdV1(result.user.fullName || result.user.name || telegramId)}** (\`${telegramId}\`)\n` +
    `📦 Tarif: **${sanitizeMdV1(planName)}**${bonusDays > 0 ? ` + 🎁 **${bonusDays} kun BONUS**` : ''}\n` +
    `📅 Faol muddat: **${formatDateShort(result.expiresAt)}** gacha (Jami ${result.totalDays} kun)`;

  const kb = new InlineKeyboard()
    .text('👤 Mijoz kartochkasi', `adm:user:${telegramId}`)
    .text('👑 Admin Panel', 'adm:panel');

  await replyOrEdit(ctx, confirmText, kb, true);
});

adminHandler.callbackQuery(/^adm_custom:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const telegramId = ctx.match[1];
  ctx.session.step = 'ADM_CUSTOM_DURATION';
  ctx.session.tempData = { targetTelegramId: telegramId };

  const kb = new InlineKeyboard().text('❌ Bekor qilish', `adm:user:${telegramId}`);
  await ctx.reply(
    "📝 Necha oy/kun asosiy muddat va qancha bonus qo'shib beramiz?\n" +
      "Misol uchun: `'4 oy + 20 kun bonus'` yoki `'2 oy 10 kun'` yoki shunchaki `'45 kun'` deb yozing:",
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

adminHandler.callbackQuery(/^adm_pause:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const telegramId = ctx.match[1];
  await SubscriptionService.setUserStatus(telegramId, 'PAUSED');
  await ctx.api
    .sendMessage(
      telegramId,
      "⏸ Sizning obunangiz Admin tomonidan vaqtincha to'xtatildi. Ma'lumotlaringiz saqlanmoqda."
    )
    .catch(() => {});
  await ctx.answerCallbackQuery({ text: "⏸ Mijoz obunasi vaqtincha to'xtatildi." });
  await showSubscriberDetail(ctx, telegramId, true);
});

adminHandler.callbackQuery(/^adm_unpause:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const telegramId = ctx.match[1];
  await SubscriptionService.setUserStatus(telegramId, 'ACTIVE');
  await ctx.api
    .sendMessage(telegramId, '▶️ Sizning obunangiz Admin tomonidan qayta faollashtirildi!')
    .catch(() => {});
  await ctx.answerCallbackQuery({ text: '▶️ Mijoz obunasi qayta yoqildi!' });
  await showSubscriberDetail(ctx, telegramId, true);
});

adminHandler.callbackQuery(/^adm_block:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const telegramId = ctx.match[1];
  await SubscriptionService.setUserStatus(telegramId, 'BLOCKED');
  await ctx.api
    .sendMessage(telegramId, "⛔️ Kechirasiz, sizning so'rovingiz rad etildi / hisobingiz bloklandi.")
    .catch(() => {});
  await ctx.answerCallbackQuery({ text: '⛔️ Mijoz bloklandi.' });
  await showSubscriberDetail(ctx, telegramId, true);
});

// ============================================================================
// 2. ⏳ Yangi so'rovlar va To'lov cheklari
// ============================================================================
adminHandler.callbackQuery('adm:pending', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const [pendingUsers, pendingPayments] = await Promise.all([
    prisma.user.findMany({
      where: { status: 'PENDING', telegramId: { not: env.OWNER_TELEGRAM_ID } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.subscriptionPayment.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  if (!pendingUsers.length && !pendingPayments.length) {
    const kb = new InlineKeyboard().text('🔙 Admin Panelga qaytish', 'adm:panel');
    await replyOrEdit(
      ctx,
      "✅ Hozircha tasdiq kutayotgan yangi so'rovlar yoki to'lov cheklari yo'q.",
      kb,
      true
    );
    return;
  }

  const kb = new InlineKeyboard();
  const lines: string[] = [`⏳ **Yangi so'rovlar (${pendingUsers.length}) va To'lov cheklari (${pendingPayments.length}):**\n`];

  for (const u of pendingUsers) {
    const name = u.fullName || u.name || "Noma'lum";
    lines.push(`👤 **${sanitizeMdV1(name)}** (\`${u.telegramId}\`) — Tel: ${sanitizeMdV1(u.phone || "Yo'q")}`);
    kb.text(`👤 So'rov: ${name.slice(0, 20)}`, `adm:user:${u.telegramId}`).row();
  }

  for (const p of pendingPayments) {
    lines.push(`🧾 **To'lov cheki** (ID: \`${p.userTelegramId}\` | ${formatDate(p.createdAt)})`);
    kb.text(`🧾 Chekni ko'rish (${p.userTelegramId})`, `adm:view_pay:${p.id}`).row();
  }

  kb.text('🔙 Admin Panelga qaytish', 'adm:panel');
  await replyOrEdit(ctx, lines.join('\n'), kb, true);
});

adminHandler.callbackQuery(/^adm:view_pay:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const payment = await prisma.subscriptionPayment.findUnique({ where: { id: ctx.match[1] } });
  if (!payment) return ctx.answerCallbackQuery({ text: 'Chek topilmadi.', show_alert: true });

  const user = await prisma.user.findUnique({ where: { telegramId: payment.userTelegramId } });
  const caption =
    `🧾 TO'LOV CHEKI\n` +
    `👤 Mijoz: ${user?.fullName || user?.name || payment.userTelegramId}\n` +
    `📱 Tel: ${user?.phone || 'Kiritilmagan'}\n` +
    `🆔 ID: ${payment.userTelegramId}\n` +
    `📅 Vaqti: ${formatDate(payment.createdAt)}`;

  const kb = SubscriptionService.getAdminPaymentApprovalKeyboard(payment.id);
  if (payment.screenshotFileId) {
    await ctx.replyWithPhoto(payment.screenshotFileId, { caption, reply_markup: kb });
  } else {
    await ctx.reply(caption, { reply_markup: kb });
  }
});

adminHandler.callbackQuery(/^adm_pay:([^:]+):(\d+):(\d+):([^:]+):(\d+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const [, paymentId, rawBase, rawBonus, planName, rawMonths] = ctx.match;
  const baseDays = parseInt(rawBase, 10) || 30;
  const bonusDays = parseInt(rawBonus, 10) || 0;
  const monthsGranted = parseInt(rawMonths, 10) || 1;

  try {
    const result = await SubscriptionService.approvePaymentScreenshot({
      paymentId,
      baseDays,
      bonusDays,
      planName,
      monthsGranted,
      sendSms: (targetId, smsText, replyMarkup) =>
        ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => {}),
    });

    await ctx.answerCallbackQuery({ text: "✅ To'lov tasdiqlandi va mijoz boti yoqildi!" });
    await safeReply(
      ctx,
      `✅ **To'lov cheki tasdiqlandi!**\n` +
        `👤 Mijoz: \`${result.user.telegramId}\`\n` +
        `📦 Tarif: **${sanitizeMdV1(planName)}**${bonusDays > 0 ? ` + 🎁 **${bonusDays} kun BONUS**` : ''}\n` +
        `💰 SaaS daromadga qo'shildi: **${formatSom(result.payment.amountUzs)}**\n` +
        `📅 Yangi muddat: **${formatDateShort(result.expiresAt)}** gacha`,
      { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('👑 Admin Panel', 'adm:panel') }
    );
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi', show_alert: true });
  }
});

adminHandler.callbackQuery(/^adm_pay_custom:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const paymentId = ctx.match[1];
  ctx.session.step = 'ADM_PAY_CUSTOM_DURATION';
  ctx.session.tempData = { paymentId };
  await ctx.reply(
    "📝 Ushbu to'lov cheki uchun necha oy/kun va qancha bonus beramiz?\n" +
      "Masalan: `'4 oy + 20 kun bonus'` yoki `'3 oy + 15 kun bonus'`:",
    { parse_mode: 'Markdown' }
  );
});

adminHandler.callbackQuery(/^adm_pay_reject:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const paymentId = ctx.match[1];
  await SubscriptionService.rejectPaymentScreenshot(paymentId, (targetId, text) =>
    ctx.api.sendMessage(targetId, text)
  );
  await ctx.answerCallbackQuery({ text: "❌ To'lov cheki rad etildi." });
  await ctx.reply("❌ To'lov cheki rad etildi va mijozga xabar yuborildi.", {
    reply_markup: new InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
  });
});

// ============================================================================
// 3. 💳 Karta va Obuna narxini sozlash
// ============================================================================
async function showSystemSettingsPanel(ctx: MyContext, isEdit = true) {
  if (!ensureSuperAdmin(ctx)) return;
  const settings = await SubscriptionService.getSystemSettings();
  const text =
    `💳 **KARTA VA OBUNA NARXINI SOZLASH**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💳 **Karta raqami:** \`${sanitizeMdV1(settings.paymentCardNumber)}\`\n` +
    `👤 **Karta egasi:** **${sanitizeMdV1(settings.paymentCardHolder)}**\n` +
    `💰 **1 Oylik obuna narxi:** **${formatSom(settings.monthlyPriceUzs)}**\n` +
    `📝 **Tarif izohi:** ${sanitizeMdV1(settings.tariffInfoText || 'Standart')}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `O'zgartirmoqchi bo'lgan bo'limni tanlang:`;

  const kb = new InlineKeyboard()
    .text("💳 Karta raqamini o'zgartirish", 'adm:set_card')
    .row()
    .text("👤 Karta egasi ismini o'zgartirish", 'adm:set_holder')
    .row()
    .text("💰 Oylik obuna narxini o'zgartirish", 'adm:set_price')
    .row()
    .text("📝 Tarif ma'lumotini o'zgartirish", 'adm:set_tariff_text')
    .row()
    .text('🔙 Admin Panelga qaytish', 'adm:panel');

  await replyOrEdit(ctx, text, kb, isEdit);
}

adminHandler.callbackQuery('adm:settings', async (ctx) => {
  await showSystemSettingsPanel(ctx, true);
});

adminHandler.callbackQuery('adm:set_card', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  ctx.session.step = 'ADM_SET_CARD';
  await ctx.reply("💳 Yangi plastik karta raqamini kiriting (masalan: `8600 1234 5678 9012`):", {
    parse_mode: 'Markdown',
  });
});

adminHandler.callbackQuery('adm:set_holder', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  ctx.session.step = 'ADM_SET_HOLDER';
  await ctx.reply("👤 Karta egasining ism-familiyasini kiriting (masalan: `ALI VALIYEV`):", {
    parse_mode: 'Markdown',
  });
});

adminHandler.callbackQuery('adm:set_price', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  ctx.session.step = 'ADM_SET_PRICE';
  await ctx.reply("💰 1 oylik obuna narxini so'mda kiriting (masalan: `150000`, `150.000` yoki `150 ming`):", {
    parse_mode: 'Markdown',
  });
});

adminHandler.callbackQuery('adm:set_tariff_text', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  ctx.session.step = 'ADM_SET_TARIFF_TEXT';
  await ctx.reply("📝 Tarif va bonuslar haqida qisqacha ma'lumot matnini kiriting:");
});

// ============================================================================
// 4. 💬 Mijozga shaxsiy xabar yozish
// ============================================================================
adminHandler.callbackQuery(/^adm:dm_list:(\d+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const page = parseInt(ctx.match[1], 10) || 1;
  const PER_PAGE = 8;
  const users = await prisma.user.findMany({
    where: { telegramId: { not: env.OWNER_TELEGRAM_ID } },
    orderBy: { createdAt: 'desc' },
  });

  const totalPages = Math.ceil(users.length / PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const slice = users.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const kb = new InlineKeyboard();
  for (const u of slice) {
    const name = u.fullName || u.name || u.telegramId;
    kb.text(`💬 ${name.slice(0, 22)} (${u.telegramId})`, `adm_msg:${u.telegramId}`).row();
  }
  addPaginationRow(kb, currentPage, totalPages, 'adm:dm_list:');
  kb.text('🔙 Admin Panelga qaytish', 'adm:panel');

  await replyOrEdit(
    ctx,
    `💬 **Mijozga shaxsiy xabar yozish**\nXabar yubormoqchi bo'lgan mijozni tanlang:`,
    kb,
    true
  );
});

adminHandler.callbackQuery(/^adm_msg:(.+)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const targetTelegramId = ctx.match[1];
  ctx.session.step = 'ADM_DIRECT_MESSAGE';
  ctx.session.tempData = { targetTelegramId };
  await ctx.reply(
    `✍️ Mijoz (\`${targetTelegramId}\`) ga yuboriladigan xabar matnini yozing:`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('❌ Bekor qilish', 'adm:panel'),
    }
  );
});

// ============================================================================
// 5. 📢 Umumiy E'lon yuborish (Rassilka)
// ============================================================================
adminHandler.callbackQuery('adm:broadcast', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const kb = new InlineKeyboard()
    .text('🟢 Barcha faol obunachilarga (ACTIVE)', 'adm:bc_target:ACTIVE')
    .row()
    .text('⌛️ Muddati tugaganlarga (EXPIRED)', 'adm:bc_target:EXPIRED')
    .row()
    .text('👥 Barcha mijozlarga (ALL)', 'adm:bc_target:ALL')
    .row()
    .text('🔙 Admin Panelga qaytish', 'adm:panel');

  await replyOrEdit(
    ctx,
    `📢 **UMUMIY E'LON YUBORISH (RASSILKA)**\n\nE'lon kimlarga yuborilsin?`,
    kb,
    true
  );
});

adminHandler.callbackQuery(/^adm:bc_target:(ACTIVE|EXPIRED|ALL)$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const target = ctx.match[1];
  ctx.session.step = 'ADM_BROADCAST_CONTENT';
  ctx.session.tempData = { broadcastTarget: target };

  await ctx.reply(
    `📢 **Rassilka rejimi (${target})**\n\n` +
      `Yubormoqchi bo'lgan e'loningizni (matn, rasm yoki video) shu yerga yuboring:`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('❌ Bekor qilish', 'adm:panel'),
    }
  );
});

// ============================================================================
// 6. 📊 SaaS Daromad va Statistika
// ============================================================================
adminHandler.callbackQuery('adm:stats', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const stats = await SubscriptionService.getSaasStatistics();
  const kb = new InlineKeyboard()
    .text('🔄 Yangilash', 'adm:stats')
    .text('🔙 Admin Panel', 'adm:panel');
  await replyOrEdit(ctx, stats.formattedText, kb, true);
});

// ============================================================================
// 7. 🎬 Yo‘riqnoma Media Boshqaruvi (Super-Admin Only)
// ============================================================================
export function getOnboardingMediaPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎥 Kirish videosi', 'adm:onb_set:intro')
    .row()
    .text('🖼 Slayd 1', 'adm:onb_set:slide_1')
    .text('🖼 Slayd 2', 'adm:onb_set:slide_2')
    .row()
    .text('🖼 Slayd 3', 'adm:onb_set:slide_3')
    .text('🖼 Slayd 4', 'adm:onb_set:slide_4')
    .row()
    .text('👀 Sinab ko‘rish (Preview)', 'adm:onb_preview')
    .text('🗑 Tozalash', 'adm:onb_clear')
    .row()
    .text('🔙 Admin Panelga qaytish', 'adm:panel');
}

function getUploadTargetLabel(target: OnboardingUploadTarget): string {
  switch (target) {
    case 'intro':
      return '🎥 Kirish videosi';
    case 'slide_1':
      return '🖼 Slayd 1 (1/4)';
    case 'slide_2':
      return '🖼 Slayd 2 (2/4)';
    case 'slide_3':
      return '🖼 Slayd 3 (3/4)';
    case 'slide_4':
      return '🖼 Slayd 4 (4/4)';
  }
}

export async function showOnboardingMediaPanel(ctx: MyContext, isEdit = true) {
  if (!ensureSuperAdmin(ctx)) return;
  const media = await getOnboardingMedia();

  const introStatus = media.introVideoFileId
    ? `✅ Yuklangan (${media.introVideoType === 'video_note' ? 'Krujochek' : 'Video'})`
    : '⚪ Bo‘sh';
  const slideStatus = (idx: OnboardingSlideIndex) => {
    const item = media.slides[idx];
    if (!item?.fileId) return '⚪ Bo‘sh';
    return `✅ Yuklangan (${item.type === 'animation' ? 'GIF' : 'Rasm'})`;
  };

  const text =
    `🎬 **YO‘RIQNOMA MEDIA BOSHQARUVI**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `• 🎥 Kirish videosi: ${introStatus}\n` +
    `• 🖼 Slayd 1 (Cheklarni o‘qish): ${slideStatus(1)}\n` +
    `• 🖼 Slayd 2 (Menyusiz boshqaruv): ${slideStatus(2)}\n` +
    `• 🖼 Slayd 3 (1 tugmada sverka): ${slideStatus(3)}\n` +
    `• 🖼 Slayd 4 (CEO Dashboard): ${slideStatus(4)}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Yuklamoqchi bo‘lgan media joyini tanlang:`;

  await replyOrEdit(ctx, text, getOnboardingMediaPanelKeyboard(), isEdit);
}

adminHandler.callbackQuery('adm:onb_media', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  clearSession(ctx);
  await showOnboardingMediaPanel(ctx, true);
});

adminHandler.callbackQuery(/^adm:onb_set:(intro|slide_[1-4])$/, async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  const target = ctx.match[1] as OnboardingUploadTarget;
  ctx.session.step = 'ADM_ONBOARDING_MEDIA_UPLOAD';
  ctx.session.adminUploadTarget = target;

  const kb = new InlineKeyboard().text('❌ Bekor qilish', 'adm:onb_media');
  await ctx.reply(
    `📥 **${getUploadTargetLabel(target)}**\n\nShu yerga rasm, GIF (animation) yoki video yuboring:`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

adminHandler.callbackQuery('adm:onb_preview', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  await ctx.answerCallbackQuery({ text: '👀 Yo‘riqnoma sinovi yuborilmoqda...' }).catch(() => {});
  await sendOnboardingCarousel(ctx, { includeIntroVideo: true });
});

adminHandler.callbackQuery('adm:onb_clear', async (ctx) => {
  if (!ensureSuperAdmin(ctx)) return;
  clearSession(ctx);
  await clearOnboardingMedia();
  await ctx.answerCallbackQuery({ text: '🗑 Barcha yo‘riqnoma medialari tozalandi!' }).catch(() => {});
  await showOnboardingMediaPanel(ctx, true);
});

// ============================================================================
// ADMIN TEXT / MEDIA INPUT HANDLER
// ============================================================================
adminHandler.on(
  ['message:text', 'message:photo', 'message:animation', 'message:video', 'message:video_note'],
  async (ctx, next) => {
    const step = ctx.session.step;
    const uploadTarget = ctx.session.adminUploadTarget;
    if ((!step || !step.startsWith('ADM_')) && !uploadTarget) return next();
    if (!ensureSuperAdmin(ctx)) return next();

    const text = ctx.message.text?.trim() || '';
    if (text.startsWith('/') || (text && isMenuButton(text))) {
      clearSession(ctx);
      return next();
    }

    // 0. Super-Admin Onboarding Media Upload (photo, animation/GIF, video, video_note)
    if (uploadTarget || step === 'ADM_ONBOARDING_MEDIA_UPLOAD') {
      const target = uploadTarget;
      if (!target) {
        clearSession(ctx);
        return next();
      }

      if (target === 'intro') {
        const videoNoteId = ctx.message.video_note?.file_id;
        const videoId = ctx.message.video?.file_id;
        if (videoNoteId) {
          await setOnboardingIntroVideo(videoNoteId, 'video_note');
          clearSession(ctx);
          await ctx.reply('✅ Saqlandi!');
          return showOnboardingMediaPanel(ctx, false);
        }
        if (videoId) {
          await setOnboardingIntroVideo(videoId, 'video');
          clearSession(ctx);
          await ctx.reply('✅ Saqlandi!');
          return showOnboardingMediaPanel(ctx, false);
        }
        await ctx.reply(
          '⚠️ Kirish videosi uchun oddiy video yoki video-xabar (krujochek) yuboring:',
          { reply_markup: new InlineKeyboard().text('❌ Bekor qilish', 'adm:onb_media') }
        );
        return;
      }

      const slideIndex = Number(target.replace('slide_', '')) as OnboardingSlideIndex;
      const animationId = ctx.message.animation?.file_id;
      const photoId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;

      if (animationId) {
        await setOnboardingSlideMedia(slideIndex, animationId, 'animation');
        clearSession(ctx);
        await ctx.reply('✅ Saqlandi!');
        return showOnboardingMediaPanel(ctx, false);
      }
      if (photoId) {
        await setOnboardingSlideMedia(slideIndex, photoId, 'photo');
        clearSession(ctx);
        await ctx.reply('✅ Saqlandi!');
        return showOnboardingMediaPanel(ctx, false);
      }

      await ctx.reply(
        '⚠️ Slayd uchun rasm yoki GIF (animation) yuboring:',
        { reply_markup: new InlineKeyboard().text('❌ Bekor qilish', 'adm:onb_media') }
      );
      return;
    }

    // 1. Custom Subscription Duration for User
  if (step === 'ADM_CUSTOM_DURATION' && text) {
    const targetTelegramId = ctx.session.tempData?.targetTelegramId;
    clearSession(ctx);
    if (!targetTelegramId) return next();

    const result = await SubscriptionService.grantCustomSubscriptionText({
      telegramId: targetTelegramId,
      customText: text,
      sendSms: (targetId, smsText, replyMarkup) =>
        ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => {}),
    });

    await safeReply(
      ctx,
      `✅ **Erkin tarif va bonus muvaffaqiyatli berildi!**\n\n` +
        `👤 Mijoz ID: \`${targetTelegramId}\`\n` +
        `📦 Kiritilgan muddat: **${sanitizeMdV1(text)}** (Asosiy: ${result.baseDays} kun + Bonus: ${result.bonusDays} kun = Jami ${result.totalDays} kun)\n` +
        `📅 Tugash sanasi: **${formatDateShort(result.expiresAt)}**\n` +
        `📩 Mijozga avtomatik Bot-SMS yuborildi!`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard()
          .text('👤 Mijoz kartochkasi', `adm:user:${targetTelegramId}`)
          .text('👑 Admin Panel', 'adm:panel'),
      }
    );
    return;
  }

  // 2. Custom Subscription Duration for Payment Screenshot
  if (step === 'ADM_PAY_CUSTOM_DURATION' && text) {
    const paymentId = ctx.session.tempData?.paymentId;
    clearSession(ctx);
    if (!paymentId) return next();

    const dur = parseSubscriptionDuration(text);

    const result = await SubscriptionService.approvePaymentScreenshot({
      paymentId,
      baseDays: dur.baseDays,
      bonusDays: dur.bonusDays,
      planName: dur.planName,
      monthsGranted: dur.monthsGranted,
      sendSms: (targetId, smsText, replyMarkup) =>
        ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => {}),
    });

    await safeReply(
      ctx,
      `✅ **To'lov cheki tasdiqlandi (${sanitizeMdV1(text)})!**\n` +
        `👤 Mijoz ID: \`${result.user.telegramId}\`\n` +
        `📅 Yangi muddat: **${formatDateShort(result.expiresAt)}** gacha (Jami ${result.totalDays} kun)\n` +
        `📩 Mijozga avtomatik Bot-SMS yuborildi!`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
      }
    );
    return;
  }

  // 3. System Settings Updates
  if (step === 'ADM_SET_CARD' && text) {
    clearSession(ctx);
    await SubscriptionService.updateSystemSettings({ paymentCardNumber: text });
    await safeReply(ctx, `✅ Plastik karta raqami yangilandi: \`${sanitizeMdV1(text)}\``, { parse_mode: 'Markdown' });
    return showSystemSettingsPanel(ctx, false);
  }

  if (step === 'ADM_SET_HOLDER' && text) {
    clearSession(ctx);
    await SubscriptionService.updateSystemSettings({ paymentCardHolder: text });
    await safeReply(ctx, `✅ Karta egasi ismi yangilandi: **${sanitizeMdV1(text)}**`, { parse_mode: 'Markdown' });
    return showSystemSettingsPanel(ctx, false);
  }

  if (step === 'ADM_SET_PRICE' && text) {
    const amount = parseSmartAmount(text);
    if (!amount || amount <= 0) {
      return ctx.reply("❌ Iltimos, to'g'ri narx kiriting (masalan: 100000 yoki 100.000).");
    }
    clearSession(ctx);
    await SubscriptionService.updateSystemSettings({ monthlyPriceUzs: amount });
    await safeReply(ctx, `✅ Oylik obuna narxi yangilandi: **${formatSom(amount)}**`, {
      parse_mode: 'Markdown',
    });
    return showSystemSettingsPanel(ctx, false);
  }

  if (step === 'ADM_SET_TARIFF_TEXT' && text) {
    clearSession(ctx);
    await SubscriptionService.updateSystemSettings({ tariffInfoText: text });
    await ctx.reply(`✅ Tarif ma'lumoti yangilandi!`);
    return showSystemSettingsPanel(ctx, false);
  }

  // 4. Direct Message to Customer
  if (step === 'ADM_DIRECT_MESSAGE' && text) {
    const targetTelegramId = ctx.session.tempData?.targetTelegramId;
    clearSession(ctx);
    if (!targetTelegramId) return next();

    const replyKb = new InlineKeyboard().text('✍️ Adminga javob yozish', 'user_reply_admin');
    await ctx.api
      .sendMessage(
        targetTelegramId,
        `📩 Admindan sizga shaxsiy xabar:\n\n${text}`,
        { reply_markup: replyKb }
      )
      .catch(() => {});

    await safeReply(ctx, `✅ Xabar mijozga (\`${targetTelegramId}\`) muvaffaqiyatli yuborildi!`, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
    });
    return;
  }

  // 5. Broadcast (Text, Photo, or Video)
  if (step === 'ADM_BROADCAST_CONTENT') {
    const target = ctx.session.tempData?.broadcastTarget || 'ACTIVE';
    clearSession(ctx);

    const whereClause: any = { telegramId: { not: env.OWNER_TELEGRAM_ID } };
    if (target === 'ACTIVE') whereClause.status = 'ACTIVE';
    if (target === 'EXPIRED') whereClause.status = 'EXPIRED';

    const recipients = await prisma.user.findMany({
      where: whereClause,
      select: { telegramId: true },
    });

    let sentCount = 0;
    const photoId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;
    const videoId = ctx.message.video?.file_id;
    const caption = ctx.message.caption || '';

    for (const r of recipients) {
      try {
        if (photoId) {
          await ctx.api.sendPhoto(r.telegramId, photoId, {
            caption: caption ? `📢 ${caption}` : undefined,
          });
        } else if (videoId) {
          await ctx.api.sendVideo(r.telegramId, videoId, {
            caption: caption ? `📢 ${caption}` : undefined,
          });
        } else if (text) {
          await ctx.api.sendMessage(r.telegramId, `📢 E'LON:\n\n${text}`);
        }
        sentCount++;
      } catch {
        // Ignore blocked bot errors for individual recipients
      }
    }

    await safeReply(
      ctx,
      `✅ **Rassilka yakunlandi!**\n📊 Jami **${recipients.length}** ta mijozdan **${sentCount}** tasiga yetkazildi.`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
      }
    );
    return;
  }

  return next();
});
