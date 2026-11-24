"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminHandler = void 0;
exports.getAdminMainPanelKeyboard = getAdminMainPanelKeyboard;
exports.showSubscriberDetail = showSubscriberDetail;
exports.getOnboardingMediaPanelKeyboard = getOnboardingMediaPanelKeyboard;
exports.showOnboardingMediaPanel = showOnboardingMediaPanel;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const admin_1 = require("../../utils/admin");
const subscription_service_1 = require("../../services/subscription.service");
const account_recovery_service_1 = require("../../services/account-recovery.service");
const onboarding_service_1 = require("../../services/onboarding.service");
const start_1 = require("./start");
const formatters_1 = require("../../utils/formatters");
const telegram_1 = require("../../utils/telegram");
const inline_1 = require("../keyboards/inline");
const menu_1 = require("../keyboards/menu");
exports.adminHandler = new grammy_1.Composer();
function ensureSuperAdmin(ctx) {
    if (!ctx.from)
        return false;
    return (0, admin_1.isSuperAdmin)(ctx.from.id);
}
function nonSuperAdminWhere() {
    const adminIds = Array.from((0, admin_1.getSuperAdminIds)());
    return adminIds.length > 0 ? { telegramId: { notIn: adminIds } } : {};
}
function getStatusBadge(status) {
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
function getRemainingDaysText(expiresAt) {
    if (!expiresAt)
        return "Muddat yo'q";
    const diffMs = new Date(expiresAt).getTime() - Date.now();
    const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    if (days <= 0)
        return 'Muddati tugagan';
    if (days > 3650)
        return 'Cheksiz';
    return `📅 ${days} kun qoldi`;
}
function getAdminMainPanelKeyboard() {
    return new grammy_1.InlineKeyboard()
        .text("👥 Obunachilar ro'yxati va Boshqaruv", 'adm:users:1')
        .row()
        .text('🔄 Akkauntni ko‘chirish', 'adm:transfer')
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
async function showAdminMainPanel(ctx, isEdit = false) {
    if (!ensureSuperAdmin(ctx))
        return;
    const stats = await subscription_service_1.SubscriptionService.getSaasStatistics();
    const text = `👑 **SMARTBAQQOL SAAS — SUPER-ADMIN PANELI**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👥 Jami mijozlar: **${stats.totalUsers} ta** | 🟢 Faol: **${stats.activeUsers} ta**\n` +
        `⏳ Yangi so'rovlar: **${stats.pendingUsers} ta** | 🧾 Cheklar: **${stats.pendingPaymentsCount} ta**\n` +
        `💰 Shu oylik daromad: **${(0, formatters_1.formatSom)(stats.monthlyRevenueUzs)}**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Quyidagi boshqaruv bo'limlaridan birini tanlang:`;
    await (0, telegram_1.replyOrEdit)(ctx, text, getAdminMainPanelKeyboard(), isEdit);
}
exports.adminHandler.hears('👑 Admin Panel', async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await showAdminMainPanel(ctx, false);
});
exports.adminHandler.command('admin', async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await showAdminMainPanel(ctx, false);
});
exports.adminHandler.callbackQuery('adm:panel', async (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    await showAdminMainPanel(ctx, true);
});
// ============================================================================
// 1. 👥 Obunachilar ro'yxati va Boshqaruv
// ============================================================================
async function showSubscribersList(ctx, page = 1, isEdit = true) {
    if (!ensureSuperAdmin(ctx))
        return;
    const PER_PAGE = 8;
    const users = await prisma_1.prisma.user.findMany({
        where: nonSuperAdminWhere(),
        orderBy: { createdAt: 'desc' },
    });
    const totalPages = Math.ceil(users.length / PER_PAGE) || 1;
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const slice = users.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);
    const kb = new grammy_1.InlineKeyboard();
    const lines = [];
    for (const u of slice) {
        const rawName = u.fullName || u.name || "Noma'lum";
        const safeName = (0, telegram_1.sanitizeMdV1)(rawName);
        const badge = getStatusBadge(u.status);
        const rem = getRemainingDaysText(u.subscriptionExpiresAt);
        lines.push(`• **${safeName}** (\`${u.telegramId}\`) — ${badge} (${rem})`);
        kb.text(`${badge} ${rawName.slice(0, 16)} (${rem})`, `adm:user:${u.telegramId}`).row();
    }
    (0, inline_1.addPaginationRow)(kb, currentPage, totalPages, 'adm:users:');
    kb.text('🔙 Admin Panelga qaytish', 'adm:panel');
    const text = `👥 **Obunachilar ro'yxati va Boshqaruv (Sahifa ${currentPage}/${totalPages})**\n\n` +
        (lines.length ? lines.join('\n') : "Hozircha mijozlar yo'q.") +
        `\n\nBoshqarish uchun mijoz ustiga bosing:`;
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
exports.adminHandler.callbackQuery(/^adm:users:(\d+)$/, async (ctx) => {
    await showSubscribersList(ctx, parseInt(ctx.match[1], 10) || 1, true);
});
async function showSubscriberDetail(ctx, telegramId, isEdit = true) {
    if (!ensureSuperAdmin(ctx))
        return;
    const user = await prisma_1.prisma.user.findUnique({ where: { telegramId } });
    if (!user)
        return ctx.answerCallbackQuery({ text: 'Foydalanuvchi topilmadi.', show_alert: true });
    const [suppliersCount, invoicesCount] = await Promise.all([
        prisma_1.prisma.supplier.count({ where: { ownerId: telegramId, isActive: true } }),
        prisma_1.prisma.invoice.count({ where: { ownerId: telegramId } }),
    ]);
    const text = `👤 **MIJOZ KARTOCHKASI**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `• **Ismi:** ${(0, telegram_1.sanitizeMdV1)(user.fullName || user.name || "Noma'lum")}\n` +
        `• **Telefon:** ${(0, telegram_1.sanitizeMdV1)(user.phone || 'Kiritilmagan')}\n` +
        `• **Username:** ${user.username ? `@${(0, telegram_1.sanitizeMdV1)(user.username)}` : 'Kiritilmagan'}\n` +
        `• **Telegram ID:** \`${user.telegramId}\`\n` +
        `• **Holati:** ${getStatusBadge(user.status)}\n` +
        `• **Tarif:** ${(0, telegram_1.sanitizeMdV1)(user.subscriptionPlan || 'Belgilanmagan')} (Bonus: ${user.bonusDaysGranted || 0} kun)\n` +
        `• **Tugash vaqti:** ${user.subscriptionExpiresAt ? `${(0, formatters_1.formatDateShort)(user.subscriptionExpiresAt)} (${getRemainingDaysText(user.subscriptionExpiresAt)})` : "Yo'q"}\n` +
        `• **Shaxsiy bazasi:** ${suppliersCount} ta ta'minotchi | ${invoicesCount} ta nakladnoy\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Tarif qo'shish yoki holatini o'zgartirish:`;
    const kb = new grammy_1.InlineKeyboard()
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
        .text(user.status === 'PAUSED' ? '▶️ Faoliyatini qayta yoqish' : "⏸ Vaqtincha to'xtatish", user.status === 'PAUSED' ? `adm_unpause:${telegramId}` : `adm_pause:${telegramId}`)
        .text('⛔️ Bloklash', `adm_block:${telegramId}`)
        .row()
        .text('💬 Shaxsiy xabar yozish', `adm_msg:${telegramId}`)
        .row()
        .text("🔙 Obunachilar ro'yxatiga", 'adm:users:1');
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
exports.adminHandler.callbackQuery(/^adm:user:(.+)$/, async (ctx) => {
    await showSubscriberDetail(ctx, ctx.match[1], true);
});
// ============================================================================
// GRANT / CUSTOM / PAUSE / BLOCK CALLBACKS
// ============================================================================
exports.adminHandler.callbackQuery(/^adm_grant:([^:]+):(\d+):(\d+):(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const [, telegramId, rawBase, rawBonus, planName] = ctx.match;
    const baseDays = parseInt(rawBase, 10) || 30;
    const bonusDays = parseInt(rawBonus, 10) || 0;
    const result = await subscription_service_1.SubscriptionService.grantSubscription({
        telegramId,
        baseDays,
        bonusDays,
        planName,
        sendSms: (targetId, smsText, replyMarkup) => ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => { }),
    });
    await ctx.answerCallbackQuery({
        text: `✅ Ruxsat berildi! (${result.totalDays} kun). Mijozga Bot-SMS yuborildi!`,
    });
    const confirmText = `✅ **Mijozga ruxsat berildi va avtomatik Bot-SMS yuborildi!**\n\n` +
        `👤 Mijoz: **${(0, telegram_1.sanitizeMdV1)(result.user.fullName || result.user.name || telegramId)}** (\`${telegramId}\`)\n` +
        `📦 Tarif: **${(0, telegram_1.sanitizeMdV1)(planName)}**${bonusDays > 0 ? ` + 🎁 **${bonusDays} kun BONUS**` : ''}\n` +
        `📅 Faol muddat: **${(0, formatters_1.formatDateShort)(result.expiresAt)}** gacha (Jami ${result.totalDays} kun)`;
    const kb = new grammy_1.InlineKeyboard()
        .text('👤 Mijoz kartochkasi', `adm:user:${telegramId}`)
        .text('👑 Admin Panel', 'adm:panel');
    await (0, telegram_1.replyOrEdit)(ctx, confirmText, kb, true);
});
exports.adminHandler.callbackQuery(/^adm_custom:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const telegramId = ctx.match[1];
    ctx.session.step = 'ADM_CUSTOM_DURATION';
    ctx.session.tempData = { targetTelegramId: telegramId };
    const kb = new grammy_1.InlineKeyboard().text('❌ Bekor qilish', `adm:user:${telegramId}`);
    await ctx.reply("📝 Necha oy/kun asosiy muddat va qancha bonus qo'shib beramiz?\n" +
        "Misol uchun: `'4 oy + 20 kun bonus'` yoki `'2 oy 10 kun'` yoki shunchaki `'45 kun'` deb yozing:", { parse_mode: 'Markdown', reply_markup: kb });
});
exports.adminHandler.callbackQuery(/^adm_pause:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const telegramId = ctx.match[1];
    await subscription_service_1.SubscriptionService.setUserStatus(telegramId, 'PAUSED');
    await ctx.api
        .sendMessage(telegramId, "⏸ Sizning obunangiz Admin tomonidan vaqtincha to'xtatildi. Ma'lumotlaringiz saqlanmoqda.")
        .catch(() => { });
    await ctx.answerCallbackQuery({ text: "⏸ Mijoz obunasi vaqtincha to'xtatildi." });
    await showSubscriberDetail(ctx, telegramId, true);
});
exports.adminHandler.callbackQuery(/^adm_unpause:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const telegramId = ctx.match[1];
    await subscription_service_1.SubscriptionService.setUserStatus(telegramId, 'ACTIVE');
    await ctx.api
        .sendMessage(telegramId, '▶️ Sizning obunangiz Admin tomonidan qayta faollashtirildi!')
        .catch(() => { });
    await ctx.answerCallbackQuery({ text: '▶️ Mijoz obunasi qayta yoqildi!' });
    await showSubscriberDetail(ctx, telegramId, true);
});
exports.adminHandler.callbackQuery(/^adm_block:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const telegramId = ctx.match[1];
    await subscription_service_1.SubscriptionService.setUserStatus(telegramId, 'BLOCKED');
    await ctx.api
        .sendMessage(telegramId, "⛔️ Kechirasiz, sizning so'rovingiz rad etildi / hisobingiz bloklandi.")
        .catch(() => { });
    await ctx.answerCallbackQuery({ text: '⛔️ Mijoz bloklandi.' });
    await showSubscriberDetail(ctx, telegramId, true);
});
// ============================================================================
// 2. ⏳ Yangi so'rovlar va To'lov cheklari
// ============================================================================
exports.adminHandler.callbackQuery('adm:pending', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const [pendingUsers, pendingPayments] = await Promise.all([
        prisma_1.prisma.user.findMany({
            where: { status: 'PENDING', ...nonSuperAdminWhere() },
            orderBy: { createdAt: 'desc' },
            take: 10,
        }),
        prisma_1.prisma.subscriptionPayment.findMany({
            where: { status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
            take: 10,
        }),
    ]);
    if (!pendingUsers.length && !pendingPayments.length) {
        const kb = new grammy_1.InlineKeyboard().text('🔙 Admin Panelga qaytish', 'adm:panel');
        await (0, telegram_1.replyOrEdit)(ctx, "✅ Hozircha tasdiq kutayotgan yangi so'rovlar yoki to'lov cheklari yo'q.", kb, true);
        return;
    }
    const kb = new grammy_1.InlineKeyboard();
    const lines = [`⏳ **Yangi so'rovlar (${pendingUsers.length}) va To'lov cheklari (${pendingPayments.length}):**\n`];
    for (const u of pendingUsers) {
        const name = u.fullName || u.name || "Noma'lum";
        lines.push(`👤 **${(0, telegram_1.sanitizeMdV1)(name)}** (\`${u.telegramId}\`) — Tel: ${(0, telegram_1.sanitizeMdV1)(u.phone || "Yo'q")}`);
        kb.text(`👤 So'rov: ${name.slice(0, 20)}`, `adm:user:${u.telegramId}`).row();
    }
    for (const p of pendingPayments) {
        lines.push(`🧾 **To'lov cheki** (ID: \`${p.userTelegramId}\` | ${(0, formatters_1.formatDate)(p.createdAt)})`);
        kb.text(`🧾 Chekni ko'rish (${p.userTelegramId})`, `adm:view_pay:${p.id}`).row();
    }
    kb.text('🔙 Admin Panelga qaytish', 'adm:panel');
    await (0, telegram_1.replyOrEdit)(ctx, lines.join('\n'), kb, true);
});
exports.adminHandler.callbackQuery(/^adm:view_pay:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const payment = await prisma_1.prisma.subscriptionPayment.findUnique({ where: { id: ctx.match[1] } });
    if (!payment)
        return ctx.answerCallbackQuery({ text: 'Chek topilmadi.', show_alert: true });
    const user = await prisma_1.prisma.user.findUnique({ where: { telegramId: payment.userTelegramId } });
    const caption = `🧾 TO'LOV CHEKI\n` +
        `👤 Mijoz: ${user?.fullName || user?.name || payment.userTelegramId}\n` +
        `📱 Tel: ${user?.phone || 'Kiritilmagan'}\n` +
        `🆔 ID: ${payment.userTelegramId}\n` +
        `📅 Vaqti: ${(0, formatters_1.formatDate)(payment.createdAt)}`;
    const kb = subscription_service_1.SubscriptionService.getAdminPaymentApprovalKeyboard(payment.id);
    if (payment.screenshotFileId) {
        await ctx.replyWithPhoto(payment.screenshotFileId, { caption, reply_markup: kb });
    }
    else {
        await ctx.reply(caption, { reply_markup: kb });
    }
});
exports.adminHandler.callbackQuery(/^adm_pay:([^:]+):(\d+):(\d+):([^:]+):(\d+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const [, paymentId, rawBase, rawBonus, planName, rawMonths] = ctx.match;
    const baseDays = parseInt(rawBase, 10) || 30;
    const bonusDays = parseInt(rawBonus, 10) || 0;
    const monthsGranted = parseInt(rawMonths, 10) || 1;
    try {
        const result = await subscription_service_1.SubscriptionService.approvePaymentScreenshot({
            paymentId,
            baseDays,
            bonusDays,
            planName,
            monthsGranted,
            sendSms: (targetId, smsText, replyMarkup) => ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => { }),
        });
        await ctx.answerCallbackQuery({ text: "✅ To'lov tasdiqlandi va mijoz boti yoqildi!" });
        await (0, telegram_1.safeReply)(ctx, `✅ **To'lov cheki tasdiqlandi!**\n` +
            `👤 Mijoz: \`${result.user.telegramId}\`\n` +
            `📦 Tarif: **${(0, telegram_1.sanitizeMdV1)(planName)}**${bonusDays > 0 ? ` + 🎁 **${bonusDays} kun BONUS**` : ''}\n` +
            `💰 SaaS daromadga qo'shildi: **${(0, formatters_1.formatSom)(result.payment.amountUzs)}**\n` +
            `📅 Yangi muddat: **${(0, formatters_1.formatDateShort)(result.expiresAt)}** gacha`, { parse_mode: 'Markdown', reply_markup: new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel') });
    }
    catch (err) {
        await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi', show_alert: true });
    }
});
exports.adminHandler.callbackQuery(/^adm_pay_custom:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const paymentId = ctx.match[1];
    ctx.session.step = 'ADM_PAY_CUSTOM_DURATION';
    ctx.session.tempData = { paymentId };
    await ctx.reply("📝 Ushbu to'lov cheki uchun necha oy/kun va qancha bonus beramiz?\n" +
        "Masalan: `'4 oy + 20 kun bonus'` yoki `'3 oy + 15 kun bonus'`:", { parse_mode: 'Markdown' });
});
exports.adminHandler.callbackQuery(/^adm_pay_reject:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const paymentId = ctx.match[1];
    await subscription_service_1.SubscriptionService.rejectPaymentScreenshot(paymentId, (targetId, text) => ctx.api.sendMessage(targetId, text));
    await ctx.answerCallbackQuery({ text: "❌ To'lov cheki rad etildi." });
    await ctx.reply("❌ To'lov cheki rad etildi va mijozga xabar yuborildi.", {
        reply_markup: new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
    });
});
// ============================================================================
// 3. 💳 Karta va Obuna narxini sozlash
// ============================================================================
async function showSystemSettingsPanel(ctx, isEdit = true) {
    if (!ensureSuperAdmin(ctx))
        return;
    const settings = await subscription_service_1.SubscriptionService.getSystemSettings();
    const text = `💳 **KARTA VA OBUNA NARXINI SOZLASH**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💳 **Karta raqami:** \`${(0, telegram_1.sanitizeMdV1)(settings.paymentCardNumber)}\`\n` +
        `👤 **Karta egasi:** **${(0, telegram_1.sanitizeMdV1)(settings.paymentCardHolder)}**\n` +
        `💰 **1 Oylik obuna narxi:** **${(0, formatters_1.formatSom)(settings.monthlyPriceUzs)}**\n` +
        `📝 **Tarif izohi:** ${(0, telegram_1.sanitizeMdV1)(settings.tariffInfoText || 'Standart')}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `O'zgartirmoqchi bo'lgan bo'limni tanlang:`;
    const kb = new grammy_1.InlineKeyboard()
        .text("💳 Karta raqamini o'zgartirish", 'adm:set_card')
        .row()
        .text("👤 Karta egasi ismini o'zgartirish", 'adm:set_holder')
        .row()
        .text("💰 Oylik obuna narxini o'zgartirish", 'adm:set_price')
        .row()
        .text("📝 Tarif ma'lumotini o'zgartirish", 'adm:set_tariff_text')
        .row()
        .text('🔙 Admin Panelga qaytish', 'adm:panel');
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
exports.adminHandler.callbackQuery('adm:settings', async (ctx) => {
    await showSystemSettingsPanel(ctx, true);
});
exports.adminHandler.callbackQuery('adm:set_card', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    ctx.session.step = 'ADM_SET_CARD';
    await ctx.reply("💳 Yangi plastik karta raqamini kiriting (masalan: `8600 1234 5678 9012`):", {
        parse_mode: 'Markdown',
    });
});
exports.adminHandler.callbackQuery('adm:set_holder', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    ctx.session.step = 'ADM_SET_HOLDER';
    await ctx.reply("👤 Karta egasining ism-familiyasini kiriting (masalan: `ALI VALIYEV`):", {
        parse_mode: 'Markdown',
    });
});
exports.adminHandler.callbackQuery('adm:set_price', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    ctx.session.step = 'ADM_SET_PRICE';
    await ctx.reply("💰 1 oylik obuna narxini so'mda kiriting (masalan: `150000`, `150.000` yoki `150 ming`):", {
        parse_mode: 'Markdown',
    });
});
exports.adminHandler.callbackQuery('adm:set_tariff_text', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    ctx.session.step = 'ADM_SET_TARIFF_TEXT';
    await ctx.reply("📝 Tarif va bonuslar haqida qisqacha ma'lumot matnini kiriting:");
});
// ============================================================================
// 4. 💬 Mijozga shaxsiy xabar yozish
// ============================================================================
exports.adminHandler.callbackQuery(/^adm:dm_list:(\d+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const page = parseInt(ctx.match[1], 10) || 1;
    const PER_PAGE = 8;
    const users = await prisma_1.prisma.user.findMany({
        where: nonSuperAdminWhere(),
        orderBy: { createdAt: 'desc' },
    });
    const totalPages = Math.ceil(users.length / PER_PAGE) || 1;
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const slice = users.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);
    const kb = new grammy_1.InlineKeyboard();
    for (const u of slice) {
        const name = u.fullName || u.name || u.telegramId;
        kb.text(`💬 ${name.slice(0, 22)} (${u.telegramId})`, `adm_msg:${u.telegramId}`).row();
    }
    (0, inline_1.addPaginationRow)(kb, currentPage, totalPages, 'adm:dm_list:');
    kb.text('🔙 Admin Panelga qaytish', 'adm:panel');
    await (0, telegram_1.replyOrEdit)(ctx, `💬 **Mijozga shaxsiy xabar yozish**\nXabar yubormoqchi bo'lgan mijozni tanlang:`, kb, true);
});
exports.adminHandler.callbackQuery(/^adm_msg:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const targetTelegramId = ctx.match[1];
    ctx.session.step = 'ADM_DIRECT_MESSAGE';
    ctx.session.tempData = { targetTelegramId };
    await ctx.reply(`✍️ Mijoz (\`${targetTelegramId}\`) ga yuboriladigan xabar matnini yozing:`, {
        parse_mode: 'Markdown',
        reply_markup: new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:panel'),
    });
});
// ============================================================================
// 5. 📢 Umumiy E'lon yuborish (Rassilka)
// ============================================================================
exports.adminHandler.callbackQuery('adm:broadcast', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const kb = new grammy_1.InlineKeyboard()
        .text('🟢 Barcha faol obunachilarga (ACTIVE)', 'adm:bc_target:ACTIVE')
        .row()
        .text('⌛️ Muddati tugaganlarga (EXPIRED)', 'adm:bc_target:EXPIRED')
        .row()
        .text('👥 Barcha mijozlarga (ALL)', 'adm:bc_target:ALL')
        .row()
        .text('🔙 Admin Panelga qaytish', 'adm:panel');
    await (0, telegram_1.replyOrEdit)(ctx, `📢 **UMUMIY E'LON YUBORISH (RASSILKA)**\n\nE'lon kimlarga yuborilsin?`, kb, true);
});
exports.adminHandler.callbackQuery(/^adm:bc_target:(ACTIVE|EXPIRED|ALL)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const target = ctx.match[1];
    ctx.session.step = 'ADM_BROADCAST_CONTENT';
    ctx.session.tempData = { broadcastTarget: target };
    await ctx.reply(`📢 **Rassilka rejimi (${target})**\n\n` +
        `Yubormoqchi bo'lgan e'loningizni (matn, rasm yoki video) shu yerga yuboring:`, {
        parse_mode: 'Markdown',
        reply_markup: new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:panel'),
    });
});
// ============================================================================
// 6. 📊 SaaS Daromad va Statistika
// ============================================================================
exports.adminHandler.callbackQuery('adm:stats', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const stats = await subscription_service_1.SubscriptionService.getSaasStatistics();
    const kb = new grammy_1.InlineKeyboard()
        .text('🔄 Yangilash', 'adm:stats')
        .text('🔙 Admin Panel', 'adm:panel');
    await (0, telegram_1.replyOrEdit)(ctx, stats.formattedText, kb, true);
});
// ============================================================================
// 7. 🎬 Yo‘riqnoma Media Boshqaruvi (Super-Admin Only)
// ============================================================================
function getOnboardingMediaPanelKeyboard() {
    return new grammy_1.InlineKeyboard()
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
function getUploadTargetLabel(target) {
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
async function showOnboardingMediaPanel(ctx, isEdit = true) {
    if (!ensureSuperAdmin(ctx))
        return;
    const media = await (0, onboarding_service_1.getOnboardingMedia)();
    const introStatus = media.introVideoFileId
        ? `✅ Yuklangan (${media.introVideoType === 'video_note' ? 'Krujochek' : 'Video'})`
        : '⚪ Bo‘sh';
    const slideStatus = (idx) => {
        const item = media.slides[idx];
        if (!item?.fileId)
            return '⚪ Bo‘sh';
        return `✅ Yuklangan (${item.type === 'animation' ? 'GIF' : 'Rasm'})`;
    };
    const text = `🎬 **YO‘RIQNOMA MEDIA BOSHQARUVI**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `• 🎥 Kirish videosi: ${introStatus}\n` +
        `• 🖼 Slayd 1 (Cheklarni o‘qish): ${slideStatus(1)}\n` +
        `• 🖼 Slayd 2 (Menyusiz boshqaruv): ${slideStatus(2)}\n` +
        `• 🖼 Slayd 3 (1 tugmada sverka): ${slideStatus(3)}\n` +
        `• 🖼 Slayd 4 (CEO Dashboard): ${slideStatus(4)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Yuklamoqchi bo‘lgan media joyini tanlang:`;
    await (0, telegram_1.replyOrEdit)(ctx, text, getOnboardingMediaPanelKeyboard(), isEdit);
}
exports.adminHandler.callbackQuery('adm:onb_media', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    (0, telegram_1.clearSession)(ctx);
    await showOnboardingMediaPanel(ctx, true);
});
exports.adminHandler.callbackQuery(/^adm:onb_set:(intro|slide_[1-4])$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const target = ctx.match[1];
    ctx.session.step = 'ADM_ONBOARDING_MEDIA_UPLOAD';
    ctx.session.adminUploadTarget = target;
    const kb = new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:onb_media');
    await ctx.reply(`📥 **${getUploadTargetLabel(target)}**\n\nShu yerga rasm, GIF (animation) yoki video yuboring:`, { parse_mode: 'Markdown', reply_markup: kb });
});
exports.adminHandler.callbackQuery('adm:onb_preview', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    await ctx.answerCallbackQuery({ text: '👀 Yo‘riqnoma sinovi yuborilmoqda...' }).catch(() => { });
    await (0, start_1.sendOnboardingCarousel)(ctx, { includeIntroVideo: true });
});
exports.adminHandler.callbackQuery('adm:onb_clear', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    (0, telegram_1.clearSession)(ctx);
    await (0, onboarding_service_1.clearOnboardingMedia)();
    await ctx.answerCallbackQuery({ text: '🗑 Barcha yo‘riqnoma medialari tozalandi!' }).catch(() => { });
    await showOnboardingMediaPanel(ctx, true);
});
// ============================================================================
// 8. 🔄 Akkauntni ko‘chirish (Super-Admin 3-Step Account Transfer Wizard)
// ============================================================================
async function findUsersForAdminTransfer(rawQuery) {
    const query = rawQuery.trim();
    const digits = query.replace(/\D/g, '');
    const cleanUsername = query.replace(/^@/, '');
    const orConditions = [
        { telegramId: query },
        { fullName: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
        { phone: { contains: query, mode: 'insensitive' } },
    ];
    if (cleanUsername) {
        orConditions.push({ username: { contains: cleanUsername, mode: 'insensitive' } });
    }
    if (digits.length >= 4) {
        orConditions.push({ phone: { contains: digits } });
        orConditions.push({ telegramId: { contains: digits } });
    }
    return prisma_1.prisma.user.findMany({
        where: { OR: orConditions },
        orderBy: { createdAt: 'desc' },
        take: 8,
    });
}
function formatTransferUserCard(user) {
    const displayName = (0, telegram_1.sanitizeMdV1)(user.fullName || user.name || "Noma'lum");
    const phone = (0, telegram_1.sanitizeMdV1)(user.phone || 'Kiritilmagan');
    const statusText = `${getStatusBadge(user.status)} (${getRemainingDaysText(user.subscriptionExpiresAt)})`;
    return (`• **Ismi:** ${displayName}\n` +
        `• **Telefon:** ${phone}\n` +
        `• **Eski Telegram ID:** \`${user.telegramId}\`\n` +
        `• **Obuna holati:** ${statusText}`);
}
async function promptTransferStep2ForUser(ctx, user, isEdit = false) {
    ctx.session.step = 'ADM_TRANSFER_NEW_ID';
    ctx.session.tempData = { transferOldUserId: user.id };
    const text = `🔄 **AKKAUNTNI KO‘CHIRISH — 2-QADAM**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${formatTransferUserCard(user)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📥 Ushbu do‘kon ko‘chiriladigan **yangi Telegram ID** raqamini kiriting (faqat raqamlar):`;
    const kb = new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:transfer_cancel');
    await (0, telegram_1.replyOrEdit)(ctx, text, kb, isEdit);
}
exports.adminHandler.callbackQuery('adm:transfer', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    ctx.session.step = 'ADM_TRANSFER_FIND_USER';
    ctx.session.tempData = {};
    const kb = new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:transfer_cancel');
    await (0, telegram_1.replyOrEdit)(ctx, `🔄 **AKKAUNTNI KO‘CHIRISH — 1-QADAM**\n\n` +
        `Eski foydalanuvchining **telefon raqami**, **eski Telegram ID** raqami yoki **ismini** kiriting:`, kb, true);
});
exports.adminHandler.callbackQuery(/^adm:transfer_pick:(.+)$/, async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    const userId = ctx.match[1];
    const user = await prisma_1.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        await ctx.answerCallbackQuery({ text: 'Foydalanuvchi topilmadi.', show_alert: true });
        return;
    }
    await promptTransferStep2ForUser(ctx, user, true);
});
exports.adminHandler.callbackQuery('adm:transfer_cancel', async (ctx) => {
    if (!ensureSuperAdmin(ctx))
        return;
    (0, telegram_1.clearSession)(ctx);
    const kb = new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel');
    await (0, telegram_1.replyOrEdit)(ctx, '❌ Akkauntni ko‘chirish amaliyoti bekor qilindi.', kb, true);
});
exports.adminHandler.callbackQuery('adm:transfer_confirm', async (ctx) => {
    if (!ensureSuperAdmin(ctx) || !ctx.from)
        return;
    const oldUserId = ctx.session.tempData?.transferOldUserId;
    const newTelegramId = ctx.session.tempData?.transferNewTelegramId;
    (0, telegram_1.clearSession)(ctx);
    if (!oldUserId || !newTelegramId) {
        const kb = new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel');
        await (0, telegram_1.replyOrEdit)(ctx, '⚠️ Ko‘chirish sessiyasi topilmadi yoki muddati tugagan. Iltimos, qaytadan boshlang.', kb, true);
        return;
    }
    try {
        const summary = await (0, account_recovery_service_1.transferTelegramAccount)({
            oldUserId,
            newTelegramId,
            actorTelegramId: String(ctx.from.id),
            reason: 'ADMIN_TRANSFER',
        });
        // Best-effort welcome-back notification to the new Telegram account
        const targetRole = (0, admin_1.isSuperAdmin)(summary.newTelegramId) ? 'SUPER_ADMIN' : summary.role || 'STORE_OWNER';
        const welcomeText = `🎉 Xush kelibsiz, ${summary.fullName || summary.name || "Do'kon egasi"}!\n\n` +
            `🔄 Super-Admin tomonidan shaxsiy do‘kon bazangiz va obunangiz ushbu yangi Telegram akkauntingizga to‘liq ko‘chirildi.\n` +
            `📅 Obuna holati: ${getStatusBadge(summary.status)} (${getRemainingDaysText(summary.subscriptionExpiresAt)})\n\n` +
            `🔐 Kelajakda o‘zingiz 1 soniyada tiklay olishingiz uchun /kalit buyrug‘i orqali zaxira kalit olib qo‘yishni tavsiya qilamiz!`;
        await ctx.api
            .sendMessage(summary.newTelegramId, welcomeText, {
            reply_markup: (0, menu_1.getMainMenu)(targetRole),
        })
            .catch(() => { });
        const successText = `✅ **Akkaunt muvaffaqiyatli ko‘chirildi!**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `• **Mijoz:** ${(0, telegram_1.sanitizeMdV1)(summary.fullName || summary.name || "Noma'lum")}\n` +
            `• **Eski Telegram ID:** \`${summary.oldTelegramId}\`\n` +
            `• **Yangi Telegram ID:** \`${summary.newTelegramId}\`\n` +
            `• **Obuna holati:** ${getStatusBadge(summary.status)} (${getRemainingDaysText(summary.subscriptionExpiresAt)})\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📩 Yangi Telegram akkauntga xush kelibsiz xabari yuborildi.`;
        const kb = new grammy_1.InlineKeyboard()
            .text('👤 Mijoz kartochkasi', `adm:user:${summary.newTelegramId}`)
            .text('👑 Admin Panel', 'adm:panel');
        await (0, telegram_1.replyOrEdit)(ctx, successText, kb, true);
    }
    catch (err) {
        const errMsg = err instanceof account_recovery_service_1.AccountRecoveryError
            ? err.message
            : err?.message || 'Akkauntni ko‘chirishda xatolik yuz berdi.';
        const kb = new grammy_1.InlineKeyboard()
            .text('🔄 Qayta urinish', 'adm:transfer')
            .text('👑 Admin Panel', 'adm:panel');
        await (0, telegram_1.replyOrEdit)(ctx, `❌ **Ko‘chirish amalga oshmadi:**\n\n${(0, telegram_1.sanitizeMdV1)(errMsg)}`, kb, true);
    }
});
// ============================================================================
// ADMIN TEXT / MEDIA INPUT HANDLER
// ============================================================================
exports.adminHandler.on(['message:text', 'message:photo', 'message:animation', 'message:video', 'message:video_note'], async (ctx, next) => {
    const step = ctx.session.step;
    const uploadTarget = ctx.session.adminUploadTarget;
    if ((!step || !step.startsWith('ADM_')) && !uploadTarget)
        return next();
    if (!ensureSuperAdmin(ctx))
        return next();
    const text = ctx.message.text?.trim() || '';
    if (text.startsWith('/') || (text && (0, menu_1.isMenuButton)(text))) {
        (0, telegram_1.clearSession)(ctx);
        return next();
    }
    // 0. Super-Admin Onboarding Media Upload (photo, animation/GIF, video, video_note)
    if (uploadTarget || step === 'ADM_ONBOARDING_MEDIA_UPLOAD') {
        const target = uploadTarget;
        if (!target) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        if (target === 'intro') {
            const videoNoteId = ctx.message.video_note?.file_id;
            const videoId = ctx.message.video?.file_id;
            if (videoNoteId) {
                await (0, onboarding_service_1.setOnboardingIntroVideo)(videoNoteId, 'video_note');
                (0, telegram_1.clearSession)(ctx);
                await ctx.reply('✅ Saqlandi!');
                return showOnboardingMediaPanel(ctx, false);
            }
            if (videoId) {
                await (0, onboarding_service_1.setOnboardingIntroVideo)(videoId, 'video');
                (0, telegram_1.clearSession)(ctx);
                await ctx.reply('✅ Saqlandi!');
                return showOnboardingMediaPanel(ctx, false);
            }
            await ctx.reply('⚠️ Kirish videosi uchun oddiy video yoki video-xabar (krujochek) yuboring:', { reply_markup: new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:onb_media') });
            return;
        }
        const slideIndex = Number(target.replace('slide_', ''));
        const animationId = ctx.message.animation?.file_id;
        const photoId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;
        if (animationId) {
            await (0, onboarding_service_1.setOnboardingSlideMedia)(slideIndex, animationId, 'animation');
            (0, telegram_1.clearSession)(ctx);
            await ctx.reply('✅ Saqlandi!');
            return showOnboardingMediaPanel(ctx, false);
        }
        if (photoId) {
            await (0, onboarding_service_1.setOnboardingSlideMedia)(slideIndex, photoId, 'photo');
            (0, telegram_1.clearSession)(ctx);
            await ctx.reply('✅ Saqlandi!');
            return showOnboardingMediaPanel(ctx, false);
        }
        await ctx.reply('⚠️ Slayd uchun rasm yoki GIF (animation) yuboring:', { reply_markup: new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:onb_media') });
        return;
    }
    // 0.5 Super-Admin Account Transfer Step 1 & Step 2
    if (step === 'ADM_TRANSFER_FIND_USER' && text) {
        const matches = await findUsersForAdminTransfer(text);
        if (matches.length === 0) {
            await ctx.reply('❌ Bunday foydalanuvchi topilmadi. Iltimos, telefon raqami, eski Telegram ID yoki ismini qayta tekshirib kiriting:', { reply_markup: new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:transfer_cancel') });
            return;
        }
        if (matches.length === 1) {
            await promptTransferStep2ForUser(ctx, matches[0], false);
            return;
        }
        const kb = new grammy_1.InlineKeyboard();
        const lines = [
            `🔎 **Topilgan foydalanuvchilar (${matches.length} ta):**\n`,
        ];
        for (const u of matches) {
            const rawName = u.fullName || u.name || "Noma'lum";
            const phone = u.phone || 'Tel yo‘q';
            lines.push(`• **${(0, telegram_1.sanitizeMdV1)(rawName)}** | ${(0, telegram_1.sanitizeMdV1)(phone)} | ID: \`${u.telegramId}\` | ${getStatusBadge(u.status)}`);
            kb.text(`${getStatusBadge(u.status)} ${rawName.slice(0, 16)} (${u.telegramId})`, `adm:transfer_pick:${u.id}`).row();
        }
        kb.text('❌ Bekor qilish', 'adm:transfer_cancel');
        lines.push(`\nKo‘chirmoqchi bo‘lgan foydalanuvchini tanlang:`);
        await (0, telegram_1.safeReply)(ctx, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
        return;
    }
    if (step === 'ADM_TRANSFER_NEW_ID' && text) {
        const oldUserId = ctx.session.tempData?.transferOldUserId;
        if (!oldUserId) {
            (0, telegram_1.clearSession)(ctx);
            return next();
        }
        if (!/^\d+$/.test(text)) {
            await (0, telegram_1.safeReply)(ctx, '⚠️ Yangi Telegram ID faqat raqamlardan iborat bo‘lishi kerak (masalan: `987654321`). Qaytadan kiriting:', {
                parse_mode: 'Markdown',
                reply_markup: new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:transfer_cancel'),
            });
            return;
        }
        const oldUser = await prisma_1.prisma.user.findUnique({ where: { id: oldUserId } });
        if (!oldUser) {
            (0, telegram_1.clearSession)(ctx);
            await ctx.reply('❌ Eski foydalanuvchi topilmadi.', {
                reply_markup: new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
            });
            return;
        }
        if (String(oldUser.telegramId).trim() === text) {
            await ctx.reply('⚠️ Yangi Telegram ID eski Telegram ID bilan bir xil bo‘lishi mumkin emas. Boshqa Telegram ID kiriting:', { reply_markup: new grammy_1.InlineKeyboard().text('❌ Bekor qilish', 'adm:transfer_cancel') });
            return;
        }
        ctx.session.step = 'ADM_TRANSFER_CONFIRM';
        ctx.session.tempData = {
            transferOldUserId: oldUser.id,
            transferNewTelegramId: text,
        };
        const confirmSummary = `🔄 **AKKAUNTNI KO‘CHIRISH — 3-QADAM (TASDIQLASH)**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${formatTransferUserCard(oldUser)}\n` +
            `• **Yangi Telegram ID:** \`${text}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ Ushbu do‘konning barcha tarixi, qarzdorliklari va obunasi \`${oldUser.telegramId}\` dan \`${text}\` ga ko‘chiriladi. Tasdiqlaysizmi?`;
        const confirmKb = new grammy_1.InlineKeyboard()
            .text('✅ Tasdiqlash', 'adm:transfer_confirm')
            .text('❌ Bekor qilish', 'adm:transfer_cancel');
        await (0, telegram_1.safeReply)(ctx, confirmSummary, { parse_mode: 'Markdown', reply_markup: confirmKb });
        return;
    }
    // 1. Custom Subscription Duration for User
    if (step === 'ADM_CUSTOM_DURATION' && text) {
        const targetTelegramId = ctx.session.tempData?.targetTelegramId;
        (0, telegram_1.clearSession)(ctx);
        if (!targetTelegramId)
            return next();
        const result = await subscription_service_1.SubscriptionService.grantCustomSubscriptionText({
            telegramId: targetTelegramId,
            customText: text,
            sendSms: (targetId, smsText, replyMarkup) => ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => { }),
        });
        await (0, telegram_1.safeReply)(ctx, `✅ **Erkin tarif va bonus muvaffaqiyatli berildi!**\n\n` +
            `👤 Mijoz ID: \`${targetTelegramId}\`\n` +
            `📦 Kiritilgan muddat: **${(0, telegram_1.sanitizeMdV1)(text)}** (Asosiy: ${result.baseDays} kun + Bonus: ${result.bonusDays} kun = Jami ${result.totalDays} kun)\n` +
            `📅 Tugash sanasi: **${(0, formatters_1.formatDateShort)(result.expiresAt)}**\n` +
            `📩 Mijozga avtomatik Bot-SMS yuborildi!`, {
            parse_mode: 'Markdown',
            reply_markup: new grammy_1.InlineKeyboard()
                .text('👤 Mijoz kartochkasi', `adm:user:${targetTelegramId}`)
                .text('👑 Admin Panel', 'adm:panel'),
        });
        return;
    }
    // 2. Custom Subscription Duration for Payment Screenshot
    if (step === 'ADM_PAY_CUSTOM_DURATION' && text) {
        const paymentId = ctx.session.tempData?.paymentId;
        (0, telegram_1.clearSession)(ctx);
        if (!paymentId)
            return next();
        const dur = (0, subscription_service_1.parseSubscriptionDuration)(text);
        const result = await subscription_service_1.SubscriptionService.approvePaymentScreenshot({
            paymentId,
            baseDays: dur.baseDays,
            bonusDays: dur.bonusDays,
            planName: dur.planName,
            monthsGranted: dur.monthsGranted,
            sendSms: (targetId, smsText, replyMarkup) => ctx.api.sendMessage(targetId, smsText, { reply_markup: replyMarkup }).catch(() => { }),
        });
        await (0, telegram_1.safeReply)(ctx, `✅ **To'lov cheki tasdiqlandi (${(0, telegram_1.sanitizeMdV1)(text)})!**\n` +
            `👤 Mijoz ID: \`${result.user.telegramId}\`\n` +
            `📅 Yangi muddat: **${(0, formatters_1.formatDateShort)(result.expiresAt)}** gacha (Jami ${result.totalDays} kun)\n` +
            `📩 Mijozga avtomatik Bot-SMS yuborildi!`, {
            parse_mode: 'Markdown',
            reply_markup: new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
        });
        return;
    }
    // 3. System Settings Updates
    if (step === 'ADM_SET_CARD' && text) {
        (0, telegram_1.clearSession)(ctx);
        await subscription_service_1.SubscriptionService.updateSystemSettings({ paymentCardNumber: text });
        await (0, telegram_1.safeReply)(ctx, `✅ Plastik karta raqami yangilandi: \`${(0, telegram_1.sanitizeMdV1)(text)}\``, { parse_mode: 'Markdown' });
        return showSystemSettingsPanel(ctx, false);
    }
    if (step === 'ADM_SET_HOLDER' && text) {
        (0, telegram_1.clearSession)(ctx);
        await subscription_service_1.SubscriptionService.updateSystemSettings({ paymentCardHolder: text });
        await (0, telegram_1.safeReply)(ctx, `✅ Karta egasi ismi yangilandi: **${(0, telegram_1.sanitizeMdV1)(text)}**`, { parse_mode: 'Markdown' });
        return showSystemSettingsPanel(ctx, false);
    }
    if (step === 'ADM_SET_PRICE' && text) {
        const amount = (0, formatters_1.parseSmartAmount)(text);
        if (!amount || amount <= 0) {
            return ctx.reply("❌ Iltimos, to'g'ri narx kiriting (masalan: 100000 yoki 100.000).");
        }
        (0, telegram_1.clearSession)(ctx);
        await subscription_service_1.SubscriptionService.updateSystemSettings({ monthlyPriceUzs: amount });
        await (0, telegram_1.safeReply)(ctx, `✅ Oylik obuna narxi yangilandi: **${(0, formatters_1.formatSom)(amount)}**`, {
            parse_mode: 'Markdown',
        });
        return showSystemSettingsPanel(ctx, false);
    }
    if (step === 'ADM_SET_TARIFF_TEXT' && text) {
        (0, telegram_1.clearSession)(ctx);
        await subscription_service_1.SubscriptionService.updateSystemSettings({ tariffInfoText: text });
        await ctx.reply(`✅ Tarif ma'lumoti yangilandi!`);
        return showSystemSettingsPanel(ctx, false);
    }
    // 4. Direct Message to Customer
    if (step === 'ADM_DIRECT_MESSAGE' && text) {
        const targetTelegramId = ctx.session.tempData?.targetTelegramId;
        (0, telegram_1.clearSession)(ctx);
        if (!targetTelegramId)
            return next();
        const replyKb = new grammy_1.InlineKeyboard().text('✍️ Adminga javob yozish', 'user_reply_admin');
        await ctx.api
            .sendMessage(targetTelegramId, `📩 Admindan sizga shaxsiy xabar:\n\n${text}`, { reply_markup: replyKb })
            .catch(() => { });
        await (0, telegram_1.safeReply)(ctx, `✅ Xabar mijozga (\`${targetTelegramId}\`) muvaffaqiyatli yuborildi!`, {
            parse_mode: 'Markdown',
            reply_markup: new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
        });
        return;
    }
    // 5. Broadcast (Text, Photo, or Video)
    if (step === 'ADM_BROADCAST_CONTENT') {
        const target = ctx.session.tempData?.broadcastTarget || 'ACTIVE';
        (0, telegram_1.clearSession)(ctx);
        const whereClause = { ...nonSuperAdminWhere() };
        if (target === 'ACTIVE')
            whereClause.status = 'ACTIVE';
        if (target === 'EXPIRED')
            whereClause.status = 'EXPIRED';
        const recipients = await prisma_1.prisma.user.findMany({
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
                }
                else if (videoId) {
                    await ctx.api.sendVideo(r.telegramId, videoId, {
                        caption: caption ? `📢 ${caption}` : undefined,
                    });
                }
                else if (text) {
                    await ctx.api.sendMessage(r.telegramId, `📢 E'LON:\n\n${text}`);
                }
                sentCount++;
            }
            catch {
                // Ignore blocked bot errors for individual recipients
            }
        }
        await (0, telegram_1.safeReply)(ctx, `✅ **Rassilka yakunlandi!**\n📊 Jami **${recipients.length}** ta mijozdan **${sentCount}** tasiga yetkazildi.`, {
            parse_mode: 'Markdown',
            reply_markup: new grammy_1.InlineKeyboard().text('👑 Admin Panel', 'adm:panel'),
        });
        return;
    }
    return next();
});
