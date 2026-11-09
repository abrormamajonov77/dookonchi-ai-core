import { BotError } from 'grammy';
import { logger } from '../../config/logger';
import { MyContext } from '../context';

export async function errorMiddleware(err: BotError<MyContext>) {
  logger.error({ err: err.error, update: err.ctx.update, userId: err.ctx.from?.id }, 'Bot Error');
  await err.ctx.reply("Kechirasiz, xatolik yuz berdi. Iltimos, qayta urinib ko'ring.").catch(() => {});
}
