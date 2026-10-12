import { Bot, session } from 'grammy';
import { run } from '@grammyjs/runner';
import { PrismaAdapter } from '@grammyjs/storage-prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../database/prisma';
import { MyContext } from './context';

// Middlewares
import { authMiddleware } from './middlewares/auth.middleware';
import { queueMiddleware } from './middlewares/queue.middleware';
import { errorMiddleware } from './middlewares/error.middleware';

// Handlers
import { startHandler } from './handlers/start';
import { invoiceHandler } from './handlers/invoice';
import { voiceHandler } from './handlers/voice';
import { debtHandler } from './handlers/debt';
import { expenseHandler } from './handlers/expense';
import { searchHandler } from './handlers/search';
import { closingHandler } from './handlers/closing';
import { suppliersHandler } from './handlers/suppliers';
import { cashHandler } from './handlers/cash';

// Cron
import { startCronJobs } from '../services/cron.service';

const bot = new Bot<MyContext>(env.BOT_TOKEN);

// Sessions using Prisma
bot.use(
  session({
    initial: () => ({}),
    storage: new PrismaAdapter(prisma.session as any),
  })
);

// Middlewares
bot.use(queueMiddleware);
bot.use(authMiddleware);

// Catch errors
bot.catch(errorMiddleware);

// Global Typing Middleware for Text Messages
bot.use(async (ctx, next) => {
  if (ctx.message && 'text' in ctx.message) {
    // Matnli xabar yoki asosiy menyu bosilganda darhol typing statusini berish
    ctx.replyWithChatAction('typing').catch(() => {});
  }
  await next();
});

// Global Native Spinner Middleware for Callback Queries
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) {
    try {
      await next();
    } finally {
      // Barcha asinxron amallar tugagandan keyin native spinnerni yopish
      await ctx.answerCallbackQuery().catch(() => {});
    }
  } else {
    await next();
  }
});

// Handlers
bot.use(startHandler);
bot.use(invoiceHandler);
bot.use(debtHandler);
bot.use(suppliersHandler);
bot.use(cashHandler);
bot.use(expenseHandler);
bot.use(searchHandler);
bot.use(closingHandler);
bot.use(voiceHandler);

// Fallback message for unhandled
bot.on('message', async (ctx) => {
  await ctx.reply("Tushunmadim. Menyudan kerakli bo'limni tanlang yoki ovozli xabar / rasm yuboring.");
});

// Start the bot with runner
const runner = run(bot);

startCronJobs(bot);

logger.info('🤖 Smart AI Yordamchi Bot is running...');

// Graceful shutdown
const stopRunner = async () => {
  logger.info('Stopping bot...');
  if (runner.isRunning()) {
    await runner.stop();
  }
  await prisma.$disconnect();
  process.exit(0);
};
process.once('SIGINT', stopRunner);
process.once('SIGTERM', stopRunner);

// Prevent crashes from unhandled network errors (ECONNRESET)
process.on('uncaughtException', (err) => {
  logger.error(err, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Rejection');
});
