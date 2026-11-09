import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { Bot, session, StorageAdapter } from 'grammy';
import { run } from '@grammyjs/runner';
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
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'alive',
      services: ['dookonchi-ai-core', 'cryptohajmbot-watcher', 'cryptoavtoai-sniper'],
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

// --- Spawn Python Crypto-Service in parallel ---
let cryptoProcess: ChildProcess | null = null;
const cryptoBotPath = path.resolve(process.cwd(), 'crypto-service', 'bot.py');

if (fs.existsSync(cryptoBotPath) && (process.env.CRYPTO_SNIPER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN)) {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  logger.info(`🚀 Starting Crypto Service (Python: ${cryptoBotPath})...`);
  try {
    cryptoProcess = spawn(pythonCmd, ['crypto-service/bot.py'], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'inherit', 'inherit']
    });

    cryptoProcess.on('error', (err) => {
      logger.error({ err }, 'Failed to start crypto python process');
    });

    cryptoProcess.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'Crypto python process exited');
    });
  } catch (err) {
    logger.error({ err }, 'Exception while spawning crypto service');
  }
} else {
  logger.info('ℹ️ Crypto service skipped (no bot.py or tokens not set).');
}

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

const runner = run(bot);
startCronJobs(bot);
logger.info('🤖 Smart AI Yordamchi Bot is running...');

let isShuttingDown = false;
const stopRunner = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Stopping bots and closing resources...');
  clearInterval(keepAliveInterval);
  healthServer.close();

  if (cryptoProcess && !cryptoProcess.killed) {
    try {
      cryptoProcess.kill('SIGTERM');
    } catch { }
  }

  try {
    if (runner.isRunning()) await runner.stop();
    await bot.stop().catch(() => { });
  } catch (err) {
    logger.error({ err }, 'Error stopping bot runner');
  }
  await prisma.$disconnect().catch(() => { });
  process.exit(0);
};
process.once('SIGINT', () => stopRunner('SIGINT'));
process.once('SIGTERM', () => stopRunner('SIGTERM'));
process.on('uncaughtException', (err) => logger.error(err, 'Uncaught Exception'));
process.on('unhandledRejection', (reason, promise) => logger.error({ reason, promise }, 'Unhandled Rejection'));
