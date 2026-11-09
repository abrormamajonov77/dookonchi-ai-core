"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueService = exports.QueueService = void 0;
const p_queue_1 = __importDefault(require("p-queue"));
const logger_1 = require("../config/logger");
class QueueService {
    queues = new Map();
    getQueue(userId) {
        const key = String(userId);
        if (!this.queues.has(key))
            this.queues.set(key, new p_queue_1.default({ concurrency: 1, timeout: 120000, throwOnTimeout: true }));
        return this.queues.get(key);
    }
    async enqueue(userId, task) {
        const q = this.getQueue(userId);
        logger_1.logger.debug({ userId, queueSize: q.size, pending: q.pending }, 'Adding task to user queue');
        return q.add(task);
    }
}
exports.QueueService = QueueService;
exports.queueService = new QueueService();
