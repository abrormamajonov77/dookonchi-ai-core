import PQueue from 'p-queue';
import { logger } from '../config/logger';

class QueueService {
  private queues: Map<string, PQueue> = new Map();

  getQueue(userId: string | number): PQueue {
    const key = String(userId);
    if (!this.queues.has(key)) {
      this.queues.set(key, new PQueue({ concurrency: 1 }));
    }
    return this.queues.get(key)!;
  }

  async enqueue<T>(userId: string | number, task: () => Promise<T>): Promise<T> {
    const queue = this.getQueue(userId);
    logger.debug({ userId, queueSize: queue.size, pending: queue.pending }, 'Adding task to user queue');
    return queue.add(task) as Promise<T>;
  }
}

export const queueService = new QueueService();
