import { BotError } from 'grammy';
import { logger } from '../../config/logger';
import { MyContext } from '../context';

export async function errorMiddleware(err: BotError<MyContext>) {
  const ctx = err.ctx;
  logger.error({ 
    err: err.error, 
    update: ctx.update, 
    userId: ctx.from?.id 
  }, 'Bot Error');

  try {
    await ctx.reply("Kechirasiz, xatolik yuz berdi. Iltimos, qayta urinib ko'ring.");
  } catch (e) {
    logger.error({ e }, 'Failed to send error message to user');
  }
}
