import { describe, it, expect } from 'vitest';
import { parseEnv, TEST_ENV_DEFAULTS } from '../src/config/env';

describe('Environment Configuration (parseEnv)', () => {
  it('fails in production when only CRYPTO_SNIPER_BOT_TOKEN is set and dookonchi keys are missing', () => {
    const res = parseEnv({
      NODE_ENV: 'production',
      CRYPTO_SNIPER_BOT_TOKEN: '999999:crypto_only_token',
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      const missingPaths = res.error.issues.map((i) => i.path[0]);
      expect(missingPaths).toContain('DATABASE_URL');
      expect(missingPaths).toContain('BOT_TOKEN');
      expect(missingPaths).toContain('GEMINI_API_KEY');
      expect(missingPaths).toContain('OWNER_TELEGRAM_ID');
    }
  });

  it('rejects placeholder BOT_TOKEN and GEMINI_API_KEY outside test mode', () => {
    const res = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:6543/postgres',
      BOT_TOKEN: 'YOUR_TELEGRAM_BOT_TOKEN',
      GEMINI_API_KEY: 'TEST_GEMINI_API_KEY',
      OWNER_TELEGRAM_ID: '123456789',
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('BOT_TOKEN');
      expect(paths).toContain('GEMINI_API_KEY');
    }
  });

  it('succeeds in production with valid required values and trims whitespace / ignores empty DIRECT_URL', () => {
    const res = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: '  postgresql://user:pass@db.example.com:6543/postgres?pgbouncer=true  ',
      DIRECT_URL: '   ',
      BOT_TOKEN: ' 123456789:REAL_BOT_TOKEN_ABC ',
      GEMINI_API_KEY: ' AIzaRealKeyExample123 ',
      OWNER_TELEGRAM_ID: ' 8958126400 ',
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.DATABASE_URL).toBe('postgresql://user:pass@db.example.com:6543/postgres?pgbouncer=true');
      expect(res.data.DIRECT_URL).toBeUndefined();
      expect(res.data.BOT_TOKEN).toBe('123456789:REAL_BOT_TOKEN_ABC');
      expect(res.data.GEMINI_API_KEY).toBe('AIzaRealKeyExample123');
      expect(res.data.OWNER_TELEGRAM_ID).toBe('8958126400');
    }
  });

  it('falls back to test defaults when NODE_ENV is test', () => {
    const res = parseEnv({ NODE_ENV: 'test' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.DATABASE_URL).toBe(TEST_ENV_DEFAULTS.DATABASE_URL);
      expect(res.data.BOT_TOKEN).toBe(TEST_ENV_DEFAULTS.BOT_TOKEN);
      expect(res.data.GEMINI_API_KEY).toBe(TEST_ENV_DEFAULTS.GEMINI_API_KEY);
      expect(res.data.OWNER_TELEGRAM_ID).toBe(TEST_ENV_DEFAULTS.OWNER_TELEGRAM_ID);
    }
  });
});

