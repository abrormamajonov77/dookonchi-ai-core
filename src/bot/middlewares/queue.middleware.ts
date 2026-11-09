import type { NextFunction } from 'grammy';
import { queueService } from '../../services/queue.service';
import { MyContext } from '../context';

export async function queueMiddleware(ctx: MyContext, next: NextFunction) {
  return ctx.from ? queueService.enqueue(ctx.from.id, () => next()) : next();
}
