"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSuperAdminIds = parseSuperAdminIds;
exports.getSuperAdminIds = getSuperAdminIds;
exports.isSuperAdmin = isSuperAdmin;
exports.getPrimarySuperAdminId = getPrimarySuperAdminId;
const env_1 = require("../config/env");
/**
 * Parses both comma-separated `OWNER_TELEGRAM_IDS` (e.g. "11111,22222")
 * and legacy `OWNER_TELEGRAM_ID` (single ID) into a normalized `Set<string>`.
 */
function parseSuperAdminIds(source) {
    const ids = new Set();
    const addRaw = (raw) => {
        if (!raw)
            return;
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
function getSuperAdminIds(rawEnv) {
    if (rawEnv) {
        return parseSuperAdminIds(rawEnv);
    }
    const hasProcessEnvOverride = process.env.OWNER_TELEGRAM_ID !== undefined ||
        process.env.OWNER_TELEGRAM_IDS !== undefined;
    if (hasProcessEnvOverride) {
        return parseSuperAdminIds({
            OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
            OWNER_TELEGRAM_IDS: process.env.OWNER_TELEGRAM_IDS,
        });
    }
    return parseSuperAdminIds({
        OWNER_TELEGRAM_ID: env_1.env.OWNER_TELEGRAM_ID,
        OWNER_TELEGRAM_IDS: env_1.env.OWNER_TELEGRAM_IDS,
    });
}
/**
 * Centralized multi-super-admin check supporting both `OWNER_TELEGRAM_IDS`
 * and legacy `OWNER_TELEGRAM_ID`.
 */
function isSuperAdmin(telegramId, rawEnv) {
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
function getPrimarySuperAdminId(rawEnv) {
    const set = getSuperAdminIds(rawEnv);
    const first = set.values().next().value;
    return first ?? env_1.env.OWNER_TELEGRAM_ID;
}
