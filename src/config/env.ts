import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().url().default("postgresql://user:password@localhost:5432/dookonchi?schema=public"),
  DIRECT_URL: z.string().url().optional(),
  BOT_TOKEN: z.string().min(1, "Bot token is required").default("123456789:TEST_BOT_TOKEN_PLACEHOLDER"),
  GEMINI_API_KEY: z.string().min(1, "Gemini API key is required").default("TEST_GEMINI_API_KEY"),
  OWNER_TELEGRAM_ID: z.string().regex(/^\d+$/, "Owner Telegram ID must be numeric").default("123456789"),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  if (process.env.NODE_ENV === 'test') {
    console.warn("⚠️ Using test fallback environment variables");
  } else {
    console.error("❌ Invalid environment variables:", _env.error.format());
    process.exit(1);
  }
}

export const env = _env.success ? _env.data : envSchema.parse({
  DATABASE_URL: "postgresql://user:password@localhost:5432/dookonchi?schema=public",
  BOT_TOKEN: "123456789:TEST_BOT_TOKEN_PLACEHOLDER",
  GEMINI_API_KEY: "TEST_GEMINI_API_KEY",
  OWNER_TELEGRAM_ID: "123456789"
});
