import dns from 'node:dns';
import net from 'node:net';
import { z } from 'zod';
import dotenv from 'dotenv';

dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily?.(false);
const origLookup = dns.lookup.bind(dns);
(dns as any).lookup = (h: string, o: any, cb?: any) =>
  typeof o === 'function' ? origLookup(h, { family: 4 }, o) : origLookup(h, typeof o === 'number' ? { family: 4 } : { ...o, family: 4 }, cb);
dotenv.config();

const defaults = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/dookonchi?schema=public',
  BOT_TOKEN: '123456789:TEST_BOT_TOKEN_PLACEHOLDER',
  GEMINI_API_KEY: 'TEST_GEMINI_API_KEY',
  OWNER_TELEGRAM_ID: '123456789'
};

const envSchema = z.object({
  DATABASE_URL: z.string().url().default(defaults.DATABASE_URL),
  DIRECT_URL: z.string().url().optional(),
  BOT_TOKEN: z.string().min(1).default(defaults.BOT_TOKEN),
  GEMINI_API_KEY: z.string().min(1).default(defaults.GEMINI_API_KEY),
  OWNER_TELEGRAM_ID: z.string().regex(/^\d+$/).default(defaults.OWNER_TELEGRAM_ID),
});

const _env = envSchema.safeParse(process.env);
if (!_env.success && process.env.NODE_ENV !== 'test') {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}
export const env = _env.success ? _env.data : envSchema.parse(defaults);
