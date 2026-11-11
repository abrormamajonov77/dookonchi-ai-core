"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const grammy_1 = require("grammy");
const runner_1 = require("@grammyjs/runner");
const storage_prisma_1 = require("@grammyjs/storage-prisma");
const env_1 = require("../config/env");
const logger_1 = require("../config/logger");
const prisma_1 = require("../database/prisma");
const auth_middleware_1 = require("./middlewares/auth.middleware");
const queue_middleware_1 = require("./middlewares/queue.middleware");
const error_middleware_1 = require("./middlewares/error.middleware");
const start_1 = require("./handlers/start");
const invoice_1 = require("./handlers/invoice");
const voice_1 = require("./handlers/voice");
const debt_1 = require("./handlers/debt");
const expense_1 = require("./handlers/expense");
const search_1 = require("./handlers/search");
const closing_1 = require("./handlers/closing");
const report_1 = require("./handlers/report");
const suppliers_1 = require("./handlers/suppliers");
const cash_1 = require("./handlers/cash");
const cron_service_1 = require("../services/cron.service");
const baseStorage = new storage_prisma_1.PrismaAdapter(prisma_1.prisma.session);
const sessionMem = new Map();
const cachedStorage = {
    async read(key) {
        if (sessionMem.has(key))
            return sessionMem.get(key);
        const val = await baseStorage.read(key);
        if (val)
            sessionMem.set(key, val);
        return val;
    },
    async write(key, value) {
        sessionMem.set(key, value);
        await baseStorage.write(key, value);
    },
    async delete(key) {
        sessionMem.delete(key);
        await baseStorage.delete(key);
    }
};
const bot = new grammy_1.Bot(env_1.env.BOT_TOKEN);
bot.use((0, grammy_1.session)({ initial: () => ({}), storage: cachedStorage }), queue_middleware_1.queueMiddleware, auth_middleware_1.authMiddleware);
bot.catch(error_middleware_1.errorMiddleware);
bot.use(async (ctx, next) => {
    if (ctx.message && 'text' in ctx.message)
        ctx.replyWithChatAction('typing').catch(() => { });
    try {
        await next();
    }
    finally {
        if (ctx.callbackQuery)
            await ctx.answerCallbackQuery().catch(() => { });
    }
});
bot.use(start_1.startHandler, invoice_1.invoiceHandler, debt_1.debtHandler, suppliers_1.suppliersHandler, cash_1.cashHandler, expense_1.expenseHandler, search_1.searchHandler, closing_1.closingHandler, report_1.reportHandler, voice_1.voiceHandler);
bot.on('message', (ctx) => ctx.reply("🤔 Tushunmadim. Pastdagi menyudan kerakli bo'limni tanlang yoki shunchaki ovozli xabar / nakladnoy rasmini yuboring."));
const PORT = Number(process.env.PORT) || 3000;
let isShuttingDown = false;
let isStarting = true;
let dbConnected = false;
let runner = null;
let cryptoProcess = null;
let cryptoRestartTimer = null;
let runnerRestartTimer = null;
let cryptoRestartAttempts = 0;
const cryptoBotPath = node_path_1.default.resolve(process.cwd(), 'crypto-service', 'bot.py');
const isCryptoEnabled = () => node_fs_1.default.existsSync(cryptoBotPath) && Boolean(process.env.CRYPTO_SNIPER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN);
const healthServer = node_http_1.default.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    if (reqPath === '/health' || reqPath === '/') {
        const botRunning = runner ? runner.isRunning() : false;
        const cryptoEnabled = isCryptoEnabled();
        const cryptoRunning = Boolean(cryptoProcess && cryptoProcess.exitCode === null && !cryptoProcess.killed);
        const statusCode = isStarting || botRunning ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        res.end(JSON.stringify({
            status: isStarting ? 'starting' : botRunning ? 'alive' : 'degraded',
            services: ['dookonchi-ai-core', 'cryptoavtoai-sniper'],
            botRunning,
            cryptoEnabled,
            cryptoRunning,
            dbConnected,
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString()
        }));
    }
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});
healthServer.listen(PORT, '0.0.0.0', () => {
    logger_1.logger.info(`🌐 Health-check server listening on port ${PORT} (/health)`);
});
// --- Spawn & supervise Python Crypto-Service in parallel ---
function startCryptoService() {
    if (isShuttingDown)
        return;
    if (!isCryptoEnabled()) {
        logger_1.logger.info('ℹ️ Crypto service skipped (no bot.py or tokens not set).');
        return;
    }
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const startedAt = Date.now();
    logger_1.logger.info(`🚀 Starting Crypto Service (Python: ${cryptoBotPath})...`);
    try {
        const child = (0, node_child_process_1.spawn)(pythonCmd, ['-u', 'crypto-service/bot.py'], {
            cwd: process.cwd(),
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
            stdio: ['ignore', 'inherit', 'inherit']
        });
        cryptoProcess = child;
        child.on('error', (err) => {
            logger_1.logger.error({ err }, 'Failed to start crypto python process');
        });
        child.on('exit', (code, signal) => {
            if (cryptoProcess === child)
                cryptoProcess = null;
            if (isShuttingDown) {
                logger_1.logger.info({ code, signal }, 'Crypto python process stopped during shutdown');
                return;
            }
            if (Date.now() - startedAt > 60_000)
                cryptoRestartAttempts = 0;
            const delayMs = Math.min(60_000, 5_000 * 2 ** Math.min(cryptoRestartAttempts, 4));
            cryptoRestartAttempts += 1;
            logger_1.logger.error({ code, signal, restartInMs: delayMs, attempt: cryptoRestartAttempts }, 'Crypto python process exited unexpectedly; scheduling restart');
            cryptoRestartTimer = setTimeout(startCryptoService, delayMs);
            cryptoRestartTimer.unref();
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Exception while spawning crypto service');
    }
}
startCryptoService();
// Self-Ping Keep-Alive (every 10 minutes)
const keepAliveInterval = setInterval(async () => {
    const rawBaseUrl = process.env.APP_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        (process.env.KOYEB_PUBLIC_DOMAIN ? `https://${process.env.KOYEB_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`);
    const pingUrl = `${rawBaseUrl.replace(/\/$/, '')}/health`;
    try {
        const res = await fetch(pingUrl, { signal: AbortSignal.timeout(10000) });
        logger_1.logger.debug({ status: res.status, pingUrl }, 'Keep-alive self-ping OK');
    }
    catch (err) {
        logger_1.logger.warn({ err, pingUrl }, 'Keep-alive self-ping failed');
    }
}, 10 * 60 * 1000);
keepAliveInterval.unref();
const stopRunner = async (signal, exitCode = 0) => {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    logger_1.logger.info({ signal, exitCode }, 'Stopping bots and closing resources...');
    const forceExit = setTimeout(() => process.exit(exitCode), 5000);
    forceExit.unref();
    clearInterval(keepAliveInterval);
    if (cryptoRestartTimer)
        clearTimeout(cryptoRestartTimer);
    if (runnerRestartTimer)
        clearTimeout(runnerRestartTimer);
    healthServer.close();
    if (cryptoProcess && !cryptoProcess.killed) {
        try {
            cryptoProcess.kill('SIGTERM');
        }
        catch { }
    }
    try {
        if (runner?.isRunning())
            await runner.stop();
        await bot.stop().catch(() => { });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Error stopping bot runner');
    }
    await prisma_1.prisma.$disconnect().catch(() => { });
    process.exit(exitCode);
};
function startBotRunner(attempt = 0) {
    if (isShuttingDown)
        return;
    runner = (0, runner_1.run)(bot);
    logger_1.logger.info({ attempt }, '🤖 Smart AI Yordamchi Bot is running...');
    const task = runner.task();
    if (task) {
        task
            .then(() => {
            if (isShuttingDown)
                return;
            logger_1.logger.error('Bot polling loop stopped unexpectedly; restarting in 5s...');
            runnerRestartTimer = setTimeout(() => startBotRunner(attempt + 1), 5000);
            runnerRestartTimer.unref();
        })
            .catch((err) => {
            if (isShuttingDown)
                return;
            const code = err?.error_code ?? err?.status;
            if (code === 409 && attempt < 10) {
                const delayMs = Math.min(30_000, 5_000 * (attempt + 1));
                logger_1.logger.warn({ err, attempt, delayMs }, 'Telegram 409 Conflict during polling; retrying...');
                runnerRestartTimer = setTimeout(() => startBotRunner(attempt + 1), delayMs);
                runnerRestartTimer.unref();
                return;
            }
            logger_1.logger.fatal({ err }, 'Fatal bot runner error; shutting down');
            void stopRunner('RUNNER_FATAL', 1);
        });
    }
}
async function bootstrap() {
    try {
        await prisma_1.prisma.$connect();
        await prisma_1.prisma.$queryRaw `SELECT 1`;
        dbConnected = true;
        logger_1.logger.info('🗄️ PostgreSQL database connection verified.');
    }
    catch (err) {
        dbConnected = false;
        logger_1.logger.error({ err }, '❌ Initial database connection check failed (will retry on requests)');
    }
    await bot.api
        .deleteWebhook({ drop_pending_updates: false })
        .catch((err) => logger_1.logger.warn({ err }, 'Failed to delete webhook before starting polling'));
    (0, cron_service_1.startCronJobs)(bot);
    startBotRunner();
    isStarting = false;
}
void bootstrap().catch((err) => {
    logger_1.logger.fatal({ err }, 'Failed to bootstrap Smart AI Yordamchi Bot');
    void stopRunner('BOOTSTRAP_ERROR', 1);
});
process.once('SIGINT', () => void stopRunner('SIGINT', 0));
process.once('SIGTERM', () => void stopRunner('SIGTERM', 0));
process.on('uncaughtException', (err) => {
    logger_1.logger.fatal({ err }, 'Uncaught Exception');
    void stopRunner('UNCAUGHT_EXCEPTION', 1);
});
process.on('unhandledRejection', (reason, promise) => {
    logger_1.logger.error({ err: reason, promise }, 'Unhandled Rejection');
});
