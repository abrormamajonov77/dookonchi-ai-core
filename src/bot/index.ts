import http from 'node:http';
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
let runnerRestartTimer: NodeJS.Timeout | null = null;

// Note: crypto-service (@Cryptoavtoai_bot) is frozen/isolated so server resources remain 100% dedicated to dookonchi-ai-core.

const healthServer = http.createServer((req, res) => {
  const reqPath = (req.url || '/').split('?')[0];
  if (reqPath === '/health' || reqPath === '/') {
    const botRunning = runner ? runner.isRunning() : false;
    const isHealthy = !isShuttingDown && (isStarting || botRunning || runnerRestartTimer !== null);
    const statusCode = isHealthy ? 200 : 503;

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(JSON.stringify({
      status: isHealthy ? 'ok' : 'degraded',
      service: 'dookonchi-ai-core',
      botRunning,
      dbConnected,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

healthServer.on('error', (err) => {
  logger.error({ err }, 'Health-check server error');
});

healthServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`🌐 Health-check server listening on port ${PORT} (/health)`);
});

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
  logger.info({ signal, exitCode }, 'Stopping Do\'konchi AI bot and closing resources...');

  const forceExit = setTimeout(() => process.exit(exitCode), 5000);
  forceExit.unref();

  clearInterval(keepAliveInterval);
  if (runnerRestartTimer) clearTimeout(runnerRestartTimer);
  healthServer.close();

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
  if (runnerRestartTimer) {
    clearTimeout(runnerRestartTimer);
    runnerRestartTimer = null;
  }

  const startedAt = Date.now();
  runner = run(bot);
  logger.info({ attempt }, '🤖 Smart AI Yordamchi Bot is running...');

  const task = runner.task();
  if (task) {
    task
      .then(() => {
        if (isShuttingDown) return;
        const nextAttempt = Date.now() - startedAt > 60_000 ? 0 : attempt + 1;
        logger.error({ nextAttempt }, 'Bot polling loop stopped unexpectedly; restarting in 5s...');
        runnerRestartTimer = setTimeout(() => startBotRunner(nextAttempt), 5000);
        runnerRestartTimer.unref();
      })
      .catch((err: any) => {
        if (isShuttingDown) return;
        const code = err?.error_code ?? err?.status;
        if (code === 401) {
          logger.fatal({ err }, 'Invalid BOT_TOKEN (401 Unauthorized); bot runner halted');
          return;
        }
        const nextAttempt = Date.now() - startedAt > 60_000 ? 1 : attempt + 1;
        const delayMs = Math.min(60_000, 5_000 * 2 ** Math.min(nextAttempt - 1, 3));
        logger.warn({ err, code, attempt: nextAttempt, delayMs }, 'Bot polling runner interrupted; scheduling restart');
        runnerRestartTimer = setTimeout(() => startBotRunner(nextAttempt), delayMs);
        runnerRestartTimer.unref();
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
  isStarting = false;
  logger.error({ err }, 'Error during Smart AI Yordamchi Bot bootstrap; retrying runner');
  startBotRunner();
});

process.once('SIGINT', () => void stopRunner('SIGINT', 0));
process.once('SIGTERM', () => void stopRunner('SIGTERM', 0));
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception');
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ err: reason, promise }, 'Unhandled Rejection');
});
