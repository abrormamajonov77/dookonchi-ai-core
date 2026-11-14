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

export const TEST_ENV_DEFAULTS = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/dookonchi?schema=public',
  BOT_TOKEN: '123456789:TEST_BOT_TOKEN_PLACEHOLDER',
  GEMINI_API_KEY: 'TEST_GEMINI_API_KEY',
  OWNER_TELEGRAM_ID: '123456789'
} as const;

const PLACEHOLDER_BOT_TOKENS = new Set<string>([
  TEST_ENV_DEFAULTS.BOT_TOKEN,
  'YOUR_TELEGRAM_BOT_TOKEN',
]);

const PLACEHOLDER_GEMINI_KEYS = new Set<string>([
  TEST_ENV_DEFAULTS.GEMINI_API_KEY,
  'YOUR_GEMINI_API_KEY',
]);

const nonEmpty = (val: string | undefined): string | undefined => {
  const trimmed = val?.trim();
  return trimmed ? trimmed : undefined;
};

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  BOT_TOKEN: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  OWNER_TELEGRAM_ID: z.string().regex(/^\d+$/),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates required environment variables. Falls back to test placeholders only when NODE_ENV === 'test'.
 */
export function parseEnv(rawEnv: Record<string, string | undefined> = process.env) {
  const isTest = rawEnv.NODE_ENV === 'test';
  const candidate = {
    DATABASE_URL: nonEmpty(rawEnv.DATABASE_URL) ?? (isTest ? TEST_ENV_DEFAULTS.DATABASE_URL : undefined),
    DIRECT_URL: nonEmpty(rawEnv.DIRECT_URL),
    BOT_TOKEN: nonEmpty(rawEnv.BOT_TOKEN) ?? (isTest ? TEST_ENV_DEFAULTS.BOT_TOKEN : undefined),
    GEMINI_API_KEY: nonEmpty(rawEnv.GEMINI_API_KEY) ?? (isTest ? TEST_ENV_DEFAULTS.GEMINI_API_KEY : undefined),
    OWNER_TELEGRAM_ID: nonEmpty(rawEnv.OWNER_TELEGRAM_ID) ?? (isTest ? TEST_ENV_DEFAULTS.OWNER_TELEGRAM_ID : undefined),
  };

  return envSchema
    .superRefine((data, ctx) => {
      if (isTest) return;
      if (PLACEHOLDER_BOT_TOKENS.has(data.BOT_TOKEN)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BOT_TOKEN'],
          message: 'Placeholder BOT_TOKEN is not allowed outside test mode',
        });
      }
      if (PLACEHOLDER_GEMINI_KEYS.has(data.GEMINI_API_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GEMINI_API_KEY'],
          message: 'Placeholder GEMINI_API_KEY is not allowed outside test mode',
        });
      }
    })
    .safeParse(candidate);
}

const _env = parseEnv(process.env);
if (!_env.success) {
  const details = _env.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('; ');
  console.error('❌ Invalid or missing environment variables:', details);
  console.error('ℹ️ Required for dookonchi-ai-core: DATABASE_URL, BOT_TOKEN, GEMINI_API_KEY, OWNER_TELEGRAM_ID (optional: DIRECT_URL)');
  process.exit(1);
}

export const env: EnvConfig = _env.data;
