import { env } from '../config/env';

export interface SuperAdminEnvSource {
  OWNER_TELEGRAM_ID?: string;
  OWNER_TELEGRAM_IDS?: string;
}

/**
 * Parses both comma-separated `OWNER_TELEGRAM_IDS` (e.g. "11111,22222")
 * and legacy `OWNER_TELEGRAM_ID` (single ID) into a normalized `Set<string>`.
 */
export function parseSuperAdminIds(source: SuperAdminEnvSource): Set<string> {
  const ids = new Set<string>();

  const addRaw = (raw: string | undefined) => {
    if (!raw) return;
    for (const part of raw.split(',')) {
      const cleaned = part.trim();
      if (cleaned && /^\d+$/.test(cleaned)) {
        ids.add(cleaned);
      }
    }
  };

  addRaw(source.OWNER_TELEGRAM_IDS);
  addRaw(source.OWNER_TELEGRAM_ID);

  return ids;
}

/**
 * Returns the active normalized Set of Super-Admin Telegram IDs.
 * Respects explicit runtime `process.env` overrides (e.g. in tests or dynamic config)
 * while seamlessly falling back to parsed `env` configuration.
 */
export function getSuperAdminIds(rawEnv?: SuperAdminEnvSource): Set<string> {
  if (rawEnv) {
    return parseSuperAdminIds(rawEnv);
  }

  const hasProcessEnvOverride =
    process.env.OWNER_TELEGRAM_ID !== undefined ||
    process.env.OWNER_TELEGRAM_IDS !== undefined;

  if (hasProcessEnvOverride) {
    return parseSuperAdminIds({
      OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
      OWNER_TELEGRAM_IDS: process.env.OWNER_TELEGRAM_IDS,
    });
  }

  return parseSuperAdminIds({
    OWNER_TELEGRAM_ID: env.OWNER_TELEGRAM_ID,
    OWNER_TELEGRAM_IDS: env.OWNER_TELEGRAM_IDS,
  });
}

/**
 * Centralized multi-super-admin check supporting both `OWNER_TELEGRAM_IDS`
 * and legacy `OWNER_TELEGRAM_ID`.
 */
export function isSuperAdmin(
  telegramId: string | number | bigint | undefined | null,
  rawEnv?: SuperAdminEnvSource
): boolean {
  if (telegramId === undefined || telegramId === null) {
    return false;
  }
  const normalized = String(telegramId).trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return false;
  }
  return getSuperAdminIds(rawEnv).has(normalized);
}

/**
 * Returns the primary Super-Admin Telegram ID (first configured ID),
 * or falls back to `env.OWNER_TELEGRAM_ID`.
 */
export function getPrimarySuperAdminId(rawEnv?: SuperAdminEnvSource): string {
  const set = getSuperAdminIds(rawEnv);
  const first = set.values().next().value;
  return first ?? env.OWNER_TELEGRAM_ID;
}
