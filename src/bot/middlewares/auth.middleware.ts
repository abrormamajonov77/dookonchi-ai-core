import type { NextFunction } from 'grammy';
import type { User } from '@prisma/client';
import { prisma } from '../../database/prisma';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { MyContext } from '../context';

const userCache = new Map<bigint, { user: User; expiresAt: number }>();
const USER_TTL_MS = 5 * 60 * 1000;

export async function authMiddleware(ctx: MyContext, next: NextFunction) {
  if (!ctx.from) return;
  const telegramId = BigInt(ctx.from.id);
  const now = Date.now();
  const cached = userCache.get(telegramId);

  if (cached && cached.expiresAt > now) {
    ctx.user = cached.user;
    return next();
  }

  let user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    const isOwner = String(ctx.from.id) === env.OWNER_TELEGRAM_ID;
    user = await prisma.user.create({
      data: { telegramId, name: ctx.from.first_name || ctx.from.username || (isOwner ? 'Owner' : 'Sotuvchi'), role: isOwner ? 'OWNER' : 'SELLER' }
    });
    logger.info({ telegramId: ctx.from.id, role: user.role }, 'Auto-registered user');
  }

  userCache.set(telegramId, { user, expiresAt: now + USER_TTL_MS });
  ctx.user = user;
  return next();
}
