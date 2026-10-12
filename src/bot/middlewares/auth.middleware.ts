import { NextFunction } from 'grammy';
import { prisma } from '../../database/prisma';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { MyContext } from '../context';

export async function authMiddleware(ctx: MyContext, next: NextFunction) {
  if (!ctx.from) return;

  const telegramId = BigInt(ctx.from.id);
  const isOwnerId = String(ctx.from.id) === env.OWNER_TELEGRAM_ID;

  let user = await prisma.user.findUnique({
    where: { telegramId }
  });

  if (!user) {
    if (isOwnerId) {
      // Auto-create owner if they don't exist
      user = await prisma.user.create({
        data: {
          telegramId,
          name: ctx.from.first_name || 'Owner',
          role: 'OWNER'
        }
      });
      logger.info({ telegramId: ctx.from.id }, 'Auto-created OWNER account');
    } else {
      // Auto-register new user as SELLER
      user = await prisma.user.create({
        data: {
          telegramId,
          name: ctx.from.first_name || ctx.from.username || 'Sotuvchi',
          role: 'SELLER'
        }
      });
      logger.info({ telegramId: ctx.from.id }, 'Auto-registered new SELLER account');
    }
  }

  ctx.user = user;
  return next();
}
