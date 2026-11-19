import PQueue from 'p-queue';
import { logger } from '../config/logger';

const IDLE_QUEUE_TTL_MS = 30 * 60 * 1000;

export class QueueService {
  private queues = new Map<string, { queue: PQueue; lastUsedAt: number }>();
  private gcTimer: NodeJS.Timeout;

  constructor() {
    this.gcTimer = setInterval(() => this.sweepIdleQueues(), IDLE_QUEUE_TTL_MS);
    this.gcTimer.unref();
  }

  getQueue(userId: string | number): PQueue {
    const key = String(userId);
    let entry = this.queues.get(key);
    if (!entry) {
      entry = {
        queue: new PQueue({ concurrency: 1, timeout: 120000, throwOnTimeout: true }),
        lastUsedAt: Date.now(),
      };
      this.queues.set(key, entry);
    } else {
      entry.lastUsedAt = Date.now();
    }
    return entry.queue;
  }

  sweepIdleQueues(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.queues.entries()) {
      if (entry.queue.size === 0 && entry.queue.pending === 0 && now - entry.lastUsedAt > IDLE_QUEUE_TTL_MS) {
        this.queues.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async enqueue<T>(userId: string | number, task: () => Promise<T>): Promise<T> {
    const q = this.getQueue(userId);
    logger.debug({ userId, queueSize: q.size, pending: q.pending }, 'Adding task to user queue');
    return q.add(task) as Promise<T>;
  }
}

export const queueService = new QueueService();
