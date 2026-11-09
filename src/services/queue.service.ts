import PQueue from 'p-queue';
import { logger } from '../config/logger';

export class QueueService {
  private queues = new Map<string, PQueue>();

  getQueue(userId: string | number): PQueue {
    const key = String(userId);
    if (!this.queues.has(key)) this.queues.set(key, new PQueue({ concurrency: 1, timeout: 120000, throwOnTimeout: true }));
    return this.queues.get(key)!;
  }

  async enqueue<T>(userId: string | number, task: () => Promise<T>): Promise<T> {
    const q = this.getQueue(userId);
    logger.debug({ userId, queueSize: q.size, pending: q.pending }, 'Adding task to user queue');
    return q.add(task) as Promise<T>;
  }
}

export const queueService = new QueueService();
