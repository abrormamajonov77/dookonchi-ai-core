"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHandler = void 0;
const grammy_1 = require("grammy");
const menu_1 = require("../keyboards/menu");
const telegram_1 = require("../../utils/telegram");
const subscription_service_1 = require("../../services/subscription.service");
const env_1 = require("../../config/env");
const formatters_1 = require("../../utils/formatters");
exports.startHandler = new grammy_1.Composer();
exports.startHandler.command('start', async (ctx) => {
    if (!ctx.from)
        return;
    (0, telegram_1.clearSession)(ctx);
    const telegramId = String(ctx.from.id);
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
    const username = ctx.from.username || null;
    const { user } = await subscription_service_1.SubscriptionService.registerOrGetUser({
        telegramId,
        fullName,
        username,
    });
    ctx.user = user;
    // 1. Super-Admin gets immediate full menu + 👑 Admin Panel
    if (subscription_service_1.SubscriptionService.isSuperAdmin(telegramId)) {
        await (0, telegram_1.safeReply)(ctx, `👑 Assalomu alaykum, *${(0, telegram_1.sanitizeMdV1)(user.fullName || user.name || 'Super Admin')}*!\n\n` +
            `⚡️ *SmartBaqqol AI (SaaS Super-Admin)* tizimiga xush kelibsiz.\n` +
            `Sizning shaxsiy bazangiz va 👑 Admin Panel boshqaruvi tayyor.`, {
            parse_mode: 'Markdown',
            reply_markup: (0, menu_1.getMainMenu)('SUPER_ADMIN'),
        });
        return;
    }
    // 2. Active Subscriber
    if (user.status === 'ACTIVE') {
        const expText = user.subscriptionExpiresAt
            ? `\n📅 Faol obuna muddati: *${(0, formatters_1.formatDateShort)(user.subscriptionExpiresAt)}* gacha`
            : '';
        await (0, telegram_1.safeReply)(ctx, `👋 Assalomu alaykum, *${(0, telegram_1.sanitizeMdV1)(user.fullName || user.name || "Do'kon egasi")}*!\n\n` +
            `⚡️ *SmartBaqqol AI* shaxsiy bazangiz faol holatda.${expText}\n` +
            `Nakladnoy rasmini, ovozli xabar yoki matn yuborishingiz mumkin!`, {
            parse_mode: 'Markdown',
            reply_markup: (0, menu_1.getMainMenu)('STORE_OWNER'),
        });
        return;
    }
    // 3. Pending User (Waiting Room + Immediate Notification to Super-Admin)
    if (user.status === 'PENDING') {
        await ctx.reply(subscription_service_1.SubscriptionService.buildWelcomePendingMessage(), {
            reply_markup: (0, menu_1.getPendingRegistrationKeyboard)(),
        });
        const adminMsg = subscription_service_1.SubscriptionService.buildAdminNewUserRequestMessage(user);
        const adminKb = subscription_service_1.SubscriptionService.getAdminUserGrantKeyboard(user.telegramId);
        await ctx.api
            .sendMessage(env_1.env.OWNER_TELEGRAM_ID, adminMsg, { reply_markup: adminKb })
            .catch(() => { });
        return;
    }
    // 4. Expired User
    if (user.status === 'EXPIRED') {
        const kb = new grammy_1.InlineKeyboard().text("📸 To'lov chekini (skrinshot) yuborish", 'sub:send_receipt');
        await ctx.reply("⏳ Obuna muddatingiz yakunlandi. Davom ettirish uchun to'lov cheki (skrinshot) rasmini yuboring:", { reply_markup: kb });
        return;
    }
    if (user.status === 'PAUSED') {
        await ctx.reply("⏸ Sizning obunangiz Admin tomonidan vaqtincha to'xtatilgan. Ma'lumotlaringiz saqlanmoqda.");
        return;
    }
    if (user.status === 'BLOCKED') {
        await ctx.reply("⛔️ Kechirasiz, sizning hisobingiz bloklangan.");
        return;
    }
});
// Contact registration handler
exports.startHandler.on('message:contact', async (ctx) => {
    if (!ctx.from || !ctx.message.contact)
        return;
    const telegramId = String(ctx.from.id);
    const phone = ctx.message.contact.phone_number;
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
    const username = ctx.from.username || null;
    const { user } = await subscription_service_1.SubscriptionService.registerOrGetUser({
        telegramId,
        fullName,
        username,
        phone,
    });
    ctx.user = user;
    if (user.status === 'PENDING') {
        await ctx.reply("✅ Telefon raqamingiz tasdiqlandi! So'rovingiz Adminga yuborildi. Ruxsat berilishi bilan sizga shu yerda xabar keladi.", { reply_markup: { remove_keyboard: true } });
        const adminMsg = subscription_service_1.SubscriptionService.buildAdminNewUserRequestMessage(user);
        const adminKb = subscription_service_1.SubscriptionService.getAdminUserGrantKeyboard(user.telegramId);
        await ctx.api
            .sendMessage(env_1.env.OWNER_TELEGRAM_ID, adminMsg, { reply_markup: adminKb })
            .catch(() => { });
        return;
    }
    await ctx.reply('✅ Telefon raqamingiz yangilandi!', {
        reply_markup: (0, menu_1.getMainMenu)(user.role),
    });
});
// Prompt user to send payment screenshot
exports.startHandler.callbackQuery('sub:send_receipt', async (ctx) => {
    const settings = await subscription_service_1.SubscriptionService.getSystemSettings();
    ctx.session.step = 'AWAIT_SUBSCRIPTION_RECEIPT';
    await ctx.reply(`💳 **Obuna to'lovi uchun ma'lumotlar:**\n` +
        `• Karta: \`${settings.paymentCardNumber}\` (${settings.paymentCardHolder})\n` +
        `• Oylik obuna narxi: **${(0, formatters_1.formatSom)(settings.monthlyPriceUzs)}**\n` +
        `(🎁 3, 4, 6 oylik va 1 yillik to'lovlarga BONUS kunlar qo'shib beriladi!)\n\n` +
        `📸 To'lov qilgach, chek (skrinshot) rasmini shu yerga yuboring:`, { parse_mode: 'Markdown' });
});
// Handle payment screenshot upload when user is in AWAIT_SUBSCRIPTION_RECEIPT or EXPIRED / PENDING
exports.startHandler.on('message:photo', async (ctx, next) => {
    if (!ctx.from)
        return next();
    const isWaitingReceipt = ctx.session.step === 'AWAIT_SUBSCRIPTION_RECEIPT' ||
        (!subscription_service_1.SubscriptionService.isSuperAdmin(ctx.from.id) &&
            (ctx.user?.status === 'EXPIRED' || ctx.user?.status === 'PENDING'));
    if (!isWaitingReceipt)
        return next();
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    if (!bestPhoto)
        return next();
    const telegramId = String(ctx.from.id);
    const payment = await subscription_service_1.SubscriptionService.submitPaymentScreenshot({
        userTelegramId: telegramId,
        screenshotFileId: bestPhoto.file_id,
    });
    (0, telegram_1.clearSession)(ctx);
    await ctx.reply("✅ To'lov cheki (skrinshot) qabul qilindi va Adminga yuborildi!\nAdmin tasdiqlashi bilan botingiz avtomatik yonadi va sizga shu yerda xabar keladi.");
    const userFullName = ctx.user?.fullName ||
        ctx.user?.name ||
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
        "Noma'lum";
    const userPhone = ctx.user?.phone || 'Kiritilmagan';
    const username = ctx.from.username ? `@${ctx.from.username}` : 'Kiritilmagan';
    const caption = `🧾 YANGI TO'LOV CHEKI (SKRINSHOT)!\n` +
        `👤 Mijoz: ${userFullName}\n` +
        `📱 Telefon: ${userPhone}\n` +
        `🔗 Username: ${username}\n` +
        `🆔 Telegram ID: ${telegramId}\n\n` +
        `Qaysi tarif va bonus bilan obunasini tasdiqlaysiz?`;
    const kb = subscription_service_1.SubscriptionService.getAdminPaymentApprovalKeyboard(payment.id);
    await ctx.api
        .sendPhoto(env_1.env.OWNER_TELEGRAM_ID, bestPhoto.file_id, {
        caption,
        reply_markup: kb,
    })
        .catch(() => { });
});
// Direct reply from Customer to Super-Admin
exports.startHandler.callbackQuery('user_reply_admin', async (ctx) => {
    ctx.session.step = 'USER_REPLY_TO_ADMIN';
    await ctx.reply("✍️ Adminga yubormoqchi bo'lgan xabaringizni yozing:");
});
exports.startHandler.on('message:text', async (ctx, next) => {
    if (ctx.session.step !== 'USER_REPLY_TO_ADMIN')
        return next();
    const text = ctx.message.text.trim();
    if (text.startsWith('/') || (0, menu_1.isMenuButton)(text)) {
        (0, telegram_1.clearSession)(ctx);
        return next();
    }
    (0, telegram_1.clearSession)(ctx);
    const telegramId = String(ctx.from?.id || '');
    const senderName = (0, telegram_1.sanitizeMdV1)(ctx.user?.fullName ||
        ctx.user?.name ||
        ctx.from?.first_name ||
        "Do'kon egasi");
    const kb = new grammy_1.InlineKeyboard().text('💬 Javob yozish', `adm_msg:${telegramId}`);
    await ctx.api
        .sendMessage(env_1.env.OWNER_TELEGRAM_ID, `📩 **Mijozdan javob xabari keldi!**\n👤 Mijoz: ${senderName} (ID: \`${telegramId}\`)\n\n💬 Xabar:\n${(0, telegram_1.sanitizeMdV1)(text)}`, { parse_mode: 'Markdown', reply_markup: kb })
        .catch(() => { });
    await ctx.reply('✅ Xabaringiz Adminga yetkazildi!');
});
exports.startHandler.callbackQuery('menu:main', async (ctx) => {
    await (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, ctx.callbackQuery.message?.message_id);
    const role = subscription_service_1.SubscriptionService.isSuperAdmin(ctx.from?.id || '') ? 'SUPER_ADMIN' : 'STORE_OWNER';
    await ctx.reply('Bosh menyudasiz 👇', { reply_markup: (0, menu_1.getMainMenu)(role) });
});
