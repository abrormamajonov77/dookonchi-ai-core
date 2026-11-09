"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTimeout = withTimeout;
exports.withRetry = withRetry;
async function withTimeout(promise, ms = 5000) {
    let id;
    const timeout = new Promise((_, rej) => { id = setTimeout(() => rej(new Error('OPERATION_TIMEOUT')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}
async function withRetry(op, maxRetries = 3, baseDelayMs = 1000, timeoutMs = 5000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await withTimeout(op(), timeoutMs);
        }
        catch (err) {
            if (attempt >= maxRetries)
                throw err;
            await new Promise(r => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
        }
    }
    throw new Error('Unreachable');
}
