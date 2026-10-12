import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BOT_TOKEN: z.string().min(1, "Bot token is required"),
  GEMINI_API_KEY: z.string().min(1, "Gemini API key is required"),
  OWNER_TELEGRAM_ID: z.string().regex(/^\d+$/, "Owner Telegram ID must be numeric"),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("❌ Invalid environment variables:", _env.error.format());
  process.exit(1);
}

export const env = _env.data;
