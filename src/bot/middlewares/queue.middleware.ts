import { NextFunction } from 'grammy';
import { queueService } from '../../services/queue.service';
import { MyContext } from '../context';

export async function queueMiddleware(ctx: MyContext, next: NextFunction) {
  if (!ctx.from) return next();
  
  // We enqueue the entire next() chain so that concurrent messages from the same user are processed one by one
  return queueService.enqueue(ctx.from.id, () => next());
}
