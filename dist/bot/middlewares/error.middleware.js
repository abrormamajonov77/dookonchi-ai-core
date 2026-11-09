"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMiddleware = errorMiddleware;
const logger_1 = require("../../config/logger");
async function errorMiddleware(err) {
    logger_1.logger.error({ err: err.error, update: err.ctx.update, userId: err.ctx.from?.id }, 'Bot Error');
    await err.ctx.reply("Kechirasiz, xatolik yuz berdi. Iltimos, qayta urinib ko'ring.").catch(() => { });
}
