"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueService = exports.QueueService = void 0;
const p_queue_1 = __importDefault(require("p-queue"));
const logger_1 = require("../config/logger");
const IDLE_QUEUE_TTL_MS = 30 * 60 * 1000;
class QueueService {
    queues = new Map();
    gcTimer;
    constructor() {
        this.gcTimer = setInterval(() => this.sweepIdleQueues(), IDLE_QUEUE_TTL_MS);
        this.gcTimer.unref();
    }
    getQueue(userId) {
        const key = String(userId);
        let entry = this.queues.get(key);
        if (!entry) {
            entry = {
                queue: new p_queue_1.default({ concurrency: 1, timeout: 120000, throwOnTimeout: true }),
                lastUsedAt: Date.now(),
            };
            this.queues.set(key, entry);
        }
        else {
            entry.lastUsedAt = Date.now();
        }
        return entry.queue;
    }
    sweepIdleQueues(now = Date.now()) {
        let removed = 0;
        for (const [key, entry] of this.queues.entries()) {
            if (entry.queue.size === 0 && entry.queue.pending === 0 && now - entry.lastUsedAt > IDLE_QUEUE_TTL_MS) {
                this.queues.delete(key);
                removed++;
            }
        }
        return removed;
    }
    async enqueue(userId, task) {
        const q = this.getQueue(userId);
        logger_1.logger.debug({ userId, queueSize: q.size, pending: q.pending }, 'Adding task to user queue');
        return q.add(task);
    }
}
exports.QueueService = QueueService;
exports.queueService = new QueueService();
