"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
const prisma_1 = require("../../database/prisma");
const env_1 = require("../../config/env");
const logger_1 = require("../../config/logger");
const userCache = new Map();
const USER_TTL_MS = 5 * 60 * 1000;
async function authMiddleware(ctx, next) {
    if (!ctx.from)
        return;
    const telegramId = BigInt(ctx.from.id);
    const now = Date.now();
    const cached = userCache.get(telegramId);
    if (cached && cached.expiresAt > now) {
        ctx.user = cached.user;
        return next();
    }
    let user = await prisma_1.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
        const isOwner = String(ctx.from.id) === env_1.env.OWNER_TELEGRAM_ID;
        user = await prisma_1.prisma.user.create({
            data: { telegramId, name: ctx.from.first_name || ctx.from.username || (isOwner ? 'Owner' : 'Sotuvchi'), role: isOwner ? 'OWNER' : 'SELLER' }
        });
        logger_1.logger.info({ telegramId: ctx.from.id, role: user.role }, 'Auto-registered user');
    }
    userCache.set(telegramId, { user, expiresAt: now + USER_TTL_MS });
    ctx.user = user;
    return next();
}
