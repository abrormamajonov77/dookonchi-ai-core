"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueMiddleware = queueMiddleware;
const queue_service_1 = require("../../services/queue.service");
async function queueMiddleware(ctx, next) {
    return ctx.from ? queue_service_1.queueService.enqueue(ctx.from.id, () => next()) : next();
}
