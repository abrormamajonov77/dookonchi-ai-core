import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { Bot, session, StorageAdapter } from 'grammy';
import { run, RunnerHandle } from '@grammyjs/runner';
import { PrismaAdapter } from '@grammyjs/storage-prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../database/prisma';
import { MyContext, SessionData } from './context';
import { authMiddleware } from './middlewares/auth.middleware';
import { queueMiddleware } from './middlewares/queue.middleware';
import { errorMiddleware } from './middlewares/error.middleware';
import { startHandler } from './handlers/start';
import { invoiceHandler } from './handlers/invoice';
import { voiceHandler } from './handlers/voice';
import { debtHandler } from './handlers/debt';
import { expenseHandler } from './handlers/expense';
import { searchHandler } from './handlers/search';
import { closingHandler } from './handlers/closing';
import { reportHandler } from './handlers/report';
import { suppliersHandler } from './handlers/suppliers';
import { cashHandler } from './handlers/cash';
import { startCronJobs } from '../services/cron.service';

const baseStorage = new PrismaAdapter<SessionData>(prisma.session as any);
const sessionMem = new Map<string, SessionData>();

const cachedStorage: StorageAdapter<SessionData> = {
  async read(key) {
    if (sessionMem.has(key)) return sessionMem.get(key);
    const val = await baseStorage.read(key);
    if (val) sessionMem.set(key, val);
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

const bot = new Bot<MyContext>(env.BOT_TOKEN);
bot.use(session({ initial: () => ({}), storage: cachedStorage }), queueMiddleware, authMiddleware);
bot.catch(errorMiddleware);

bot.use(async (ctx, next) => {
  if (ctx.message && 'text' in ctx.message) ctx.replyWithChatAction('typing').catch(() => { });
  try { await next(); } finally { if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => { }); }
});

bot.use(startHandler, invoiceHandler, debtHandler, suppliersHandler, cashHandler, expenseHandler, searchHandler, closingHandler, reportHandler, voiceHandler);
bot.on('message', (ctx) => ctx.reply("🤔 Tushunmadim. Pastdagi menyudan kerakli bo'limni tanlang yoki shunchaki ovozli xabar / nakladnoy rasmini yuboring."));

const PORT = Number(process.env.PORT) || 3000;
let isShuttingDown = false;
let isStarting = true;
let dbConnected = false;
let runner: RunnerHandle | null = null;
let cryptoProcess: ChildProcess | null = null;
let cryptoRestartTimer: NodeJS.Timeout | null = null;
let runnerRestartTimer: NodeJS.Timeout | null = null;
let cryptoRestartAttempts = 0;

const cryptoBotPath = path.resolve(process.cwd(), 'crypto-service', 'bot.py');
const isCryptoEnabled = () =>
  fs.existsSync(cryptoBotPath) && Boolean(process.env.CRYPTO_SNIPER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN);

const healthServer = http.createServer((req, res) => {
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
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

healthServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`🌐 Health-check server listening on port ${PORT} (/health)`);
});

// --- Spawn & supervise Python Crypto-Service in parallel ---
function startCryptoService() {
  if (isShuttingDown) return;
  if (!isCryptoEnabled()) {
    logger.info('ℹ️ Crypto service skipped (no bot.py or tokens not set).');
    return;
  }

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const startedAt = Date.now();
  logger.info(`🚀 Starting Crypto Service (Python: ${cryptoBotPath})...`);
  try {
    const child = spawn(pythonCmd, ['-u', 'crypto-service/bot.py'], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'inherit', 'inherit']
    });
    cryptoProcess = child;

    child.on('error', (err) => {
      logger.error({ err }, 'Failed to start crypto python process');
    });

    child.on('exit', (code, signal) => {
      if (cryptoProcess === child) cryptoProcess = null;
      if (isShuttingDown) {
        logger.info({ code, signal }, 'Crypto python process stopped during shutdown');
        return;
      }
      if (Date.now() - startedAt > 60_000) cryptoRestartAttempts = 0;
      const delayMs = Math.min(60_000, 5_000 * 2 ** Math.min(cryptoRestartAttempts, 4));
      cryptoRestartAttempts += 1;
      logger.error({ code, signal, restartInMs: delayMs, attempt: cryptoRestartAttempts }, 'Crypto python process exited unexpectedly; scheduling restart');
      cryptoRestartTimer = setTimeout(startCryptoService, delayMs);
      cryptoRestartTimer.unref();
    });
  } catch (err) {
    logger.error({ err }, 'Exception while spawning crypto service');
  }
}

startCryptoService();

// Self-Ping Keep-Alive (every 10 minutes)
const keepAliveInterval = setInterval(async () => {
  const rawBaseUrl =
    process.env.APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.KOYEB_PUBLIC_DOMAIN ? `https://${process.env.KOYEB_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`);
  const pingUrl = `${rawBaseUrl.replace(/\/$/, '')}/health`;
  try {
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(10000) });
    logger.debug({ status: res.status, pingUrl }, 'Keep-alive self-ping OK');
  } catch (err) {
    logger.warn({ err, pingUrl }, 'Keep-alive self-ping failed');
  }
}, 10 * 60 * 1000);
keepAliveInterval.unref();

const stopRunner = async (signal: string, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal, exitCode }, 'Stopping bots and closing resources...');

  const forceExit = setTimeout(() => process.exit(exitCode), 5000);
  forceExit.unref();

  clearInterval(keepAliveInterval);
  if (cryptoRestartTimer) clearTimeout(cryptoRestartTimer);
  if (runnerRestartTimer) clearTimeout(runnerRestartTimer);
  healthServer.close();

  if (cryptoProcess && !cryptoProcess.killed) {
    try {
      cryptoProcess.kill('SIGTERM');
    } catch { }
  }

  try {
    if (runner?.isRunning()) await runner.stop();
    await bot.stop().catch(() => { });
  } catch (err) {
    logger.error({ err }, 'Error stopping bot runner');
  }
  await prisma.$disconnect().catch(() => { });
  process.exit(exitCode);
};

function startBotRunner(attempt = 0) {
  if (isShuttingDown) return;
  runner = run(bot);
  logger.info({ attempt }, '🤖 Smart AI Yordamchi Bot is running...');

  const task = runner.task();
  if (task) {
    task
      .then(() => {
        if (isShuttingDown) return;
        logger.error('Bot polling loop stopped unexpectedly; restarting in 5s...');
        runnerRestartTimer = setTimeout(() => startBotRunner(attempt + 1), 5000);
        runnerRestartTimer.unref();
      })
      .catch((err: any) => {
        if (isShuttingDown) return;
        const code = err?.error_code ?? err?.status;
        if (code === 409 && attempt < 10) {
          const delayMs = Math.min(30_000, 5_000 * (attempt + 1));
          logger.warn({ err, attempt, delayMs }, 'Telegram 409 Conflict during polling; retrying...');
          runnerRestartTimer = setTimeout(() => startBotRunner(attempt + 1), delayMs);
          runnerRestartTimer.unref();
          return;
        }
        logger.fatal({ err }, 'Fatal bot runner error; shutting down');
        void stopRunner('RUNNER_FATAL', 1);
      });
  }
}

async function bootstrap() {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
    logger.info('🗄️ PostgreSQL database connection verified.');
  } catch (err) {
    dbConnected = false;
    logger.error({ err }, '❌ Initial database connection check failed (will retry on requests)');
  }

  await bot.api
    .deleteWebhook({ drop_pending_updates: false })
    .catch((err) => logger.warn({ err }, 'Failed to delete webhook before starting polling'));

  startCronJobs(bot);
  startBotRunner();
  isStarting = false;
}

void bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to bootstrap Smart AI Yordamchi Bot');
  void stopRunner('BOOTSTRAP_ERROR', 1);
});

process.once('SIGINT', () => void stopRunner('SIGINT', 0));
process.once('SIGTERM', () => void stopRunner('SIGTERM', 0));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught Exception');
  void stopRunner('UNCAUGHT_EXCEPTION', 1);
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ err: reason, promise }, 'Unhandled Rejection');
});
