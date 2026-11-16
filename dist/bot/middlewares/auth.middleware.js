"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
const grammy_1 = require("grammy");
const logger_1 = require("../../config/logger");
const subscription_service_1 = require("../../services/subscription.service");
const menu_1 = require("../keyboards/menu");
async function authMiddleware(ctx, next) {
    if (!ctx.from)
        return;
    const telegramId = String(ctx.from.id);
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
    const username = ctx.from.username || null;
    let user = (0, subscription_service_1.getCachedUser)(telegramId);
    let isNew = false;
    if (!user) {
        const reg = await subscription_service_1.SubscriptionService.registerOrGetUser({
            telegramId,
            fullName,
            username,
        });
        user = reg.user;
        isNew = reg.isNew;
        if (isNew) {
            logger_1.logger.info({ telegramId, role: user.role, status: user.status }, 'Registered new user');
            ctx.isNewlyRegisteredUser = true;
        }
    }
    // Super-Admin always has full access
    if (subscription_service_1.SubscriptionService.isSuperAdmin(telegramId)) {
        ctx.user = user;
        return next();
    }
    // Auto-check subscription expiration without deleting any user data
    if (user.status === 'ACTIVE' &&
        user.subscriptionExpiresAt &&
        new Date() > new Date(user.subscriptionExpiresAt)) {
        user = await subscription_service_1.SubscriptionService.setUserStatus(telegramId, 'EXPIRED');
        (0, subscription_service_1.setCachedUser)(telegramId, user);
    }
    ctx.user = user;
    // If user is ACTIVE, allow all store operations in their isolated personal database
    if (user.status === 'ACTIVE') {
        return next();
    }
    // Allow registration, /start, contact sharing, payment screenshot submission, and replying to Admin
    const msgText = ctx.message?.text?.trim() || '';
    const cbData = ctx.callbackQuery?.data || '';
    const hasContact = !!ctx.message?.contact;
    const hasPhoto = !!ctx.message?.photo;
    const sessionStep = ctx.session?.step || '';
    if (msgText.startsWith('/start') ||
        hasContact ||
        cbData === 'sub:send_receipt' ||
        cbData === 'user_reply_admin' ||
        sessionStep === 'AWAIT_SUBSCRIPTION_RECEIPT' ||
        sessionStep === 'USER_REPLY_TO_ADMIN' ||
        (hasPhoto && (user.status === 'EXPIRED' || user.status === 'PENDING'))) {
        return next();
    }
    // Block unauthorized/expired access to business modules with clear status instructions
    if (user.status === 'PENDING') {
        await ctx.reply(subscription_service_1.SubscriptionService.buildWelcomePendingMessage(), {
            reply_markup: (0, menu_1.getPendingRegistrationKeyboard)(),
        });
        return;
    }
    if (user.status === 'EXPIRED') {
        const kb = new grammy_1.InlineKeyboard().text("📸 To'lov chekini (skrinshot) yuborish", 'sub:send_receipt');
        await ctx.reply("⏳ Obuna muddatingiz yakunlandi. Davom ettirish uchun to'lov cheki (skrinshot) rasmini yuboring:", { reply_markup: kb });
        return;
    }
    if (user.status === 'PAUSED') {
        await ctx.reply("⏸ Sizning obunangiz Admin tomonidan vaqtincha to'xtatilgan. Shaxsiy bazangizdagi barcha ma'lumotlar xavfsiz saqlanmoqda.");
        return;
    }
    if (user.status === 'BLOCKED') {
        await ctx.reply("⛔️ Kechirasiz, sizning hisobingiz bloklangan.");
        return;
    }
}
