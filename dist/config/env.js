"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSuperAdminIds = exports.getPrimarySuperAdminId = exports.getSuperAdminIds = exports.isSuperAdmin = exports.env = exports.TEST_ENV_DEFAULTS = void 0;
exports.parseEnv = parseEnv;
const node_dns_1 = __importDefault(require("node:dns"));
const node_net_1 = __importDefault(require("node:net"));
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
node_dns_1.default.setDefaultResultOrder('ipv4first');
node_net_1.default.setDefaultAutoSelectFamily?.(false);
const origLookup = node_dns_1.default.lookup.bind(node_dns_1.default);
node_dns_1.default.lookup = (h, o, cb) => typeof o === 'function' ? origLookup(h, { family: 4 }, o) : origLookup(h, typeof o === 'number' ? { family: 4 } : { ...o, family: 4 }, cb);
dotenv_1.default.config();
exports.TEST_ENV_DEFAULTS = {
    DATABASE_URL: 'postgresql://user:password@localhost:5432/dookonchi?schema=public',
    BOT_TOKEN: '123456789:TEST_BOT_TOKEN_PLACEHOLDER',
    GEMINI_API_KEY: 'TEST_GEMINI_API_KEY',
    OWNER_TELEGRAM_ID: '123456789'
};
const PLACEHOLDER_BOT_TOKENS = new Set([
    exports.TEST_ENV_DEFAULTS.BOT_TOKEN,
    'YOUR_TELEGRAM_BOT_TOKEN',
]);
const PLACEHOLDER_GEMINI_KEYS = new Set([
    exports.TEST_ENV_DEFAULTS.GEMINI_API_KEY,
    'YOUR_GEMINI_API_KEY',
]);
const nonEmpty = (val) => {
    const trimmed = val?.trim();
    return trimmed ? trimmed : undefined;
};
const parseIdListTokens = (raw) => {
    if (!raw)
        return [];
    return raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
};
const envSchema = zod_1.z.object({
    DATABASE_URL: zod_1.z.string().url(),
    DIRECT_URL: zod_1.z.string().url().optional(),
    BOT_TOKEN: zod_1.z.string().min(1),
    GEMINI_API_KEY: zod_1.z.string().min(1),
    OWNER_TELEGRAM_ID: zod_1.z.string().regex(/^\d+$/),
    OWNER_TELEGRAM_IDS: zod_1.z
        .string()
        .refine((val) => {
        const tokens = parseIdListTokens(val);
        return tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
    }, { message: 'OWNER_TELEGRAM_IDS must be a comma-separated list of numeric Telegram IDs' })
        .optional(),
});
/**
 * Validates required environment variables. Falls back to test placeholders only when NODE_ENV === 'test'.
 */
function parseEnv(rawEnv = process.env) {
    const isTest = rawEnv.NODE_ENV === 'test';
    const rawMultiIds = nonEmpty(rawEnv.OWNER_TELEGRAM_IDS);
    const firstFromMulti = parseIdListTokens(rawMultiIds).find((t) => /^\d+$/.test(t));
    const resolvedPrimaryOwnerId = nonEmpty(rawEnv.OWNER_TELEGRAM_ID) ??
        firstFromMulti ??
        (isTest ? exports.TEST_ENV_DEFAULTS.OWNER_TELEGRAM_ID : undefined);
    const candidate = {
        DATABASE_URL: nonEmpty(rawEnv.DATABASE_URL) ?? (isTest ? exports.TEST_ENV_DEFAULTS.DATABASE_URL : undefined),
        DIRECT_URL: nonEmpty(rawEnv.DIRECT_URL),
        BOT_TOKEN: nonEmpty(rawEnv.BOT_TOKEN) ?? (isTest ? exports.TEST_ENV_DEFAULTS.BOT_TOKEN : undefined),
        GEMINI_API_KEY: nonEmpty(rawEnv.GEMINI_API_KEY) ?? (isTest ? exports.TEST_ENV_DEFAULTS.GEMINI_API_KEY : undefined),
        OWNER_TELEGRAM_ID: resolvedPrimaryOwnerId,
        OWNER_TELEGRAM_IDS: rawMultiIds,
    };
    return envSchema
        .superRefine((data, ctx) => {
        if (isTest)
            return;
        if (PLACEHOLDER_BOT_TOKENS.has(data.BOT_TOKEN)) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                path: ['BOT_TOKEN'],
                message: 'Placeholder BOT_TOKEN is not allowed outside test mode',
            });
        }
        if (PLACEHOLDER_GEMINI_KEYS.has(data.GEMINI_API_KEY)) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
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
    console.error('ℹ️ Required for dookonchi-ai-core: DATABASE_URL, BOT_TOKEN, GEMINI_API_KEY, OWNER_TELEGRAM_ID or OWNER_TELEGRAM_IDS (optional: DIRECT_URL)');
    process.exit(1);
}
exports.env = _env.data;
var admin_1 = require("../utils/admin");
Object.defineProperty(exports, "isSuperAdmin", { enumerable: true, get: function () { return admin_1.isSuperAdmin; } });
Object.defineProperty(exports, "getSuperAdminIds", { enumerable: true, get: function () { return admin_1.getSuperAdminIds; } });
Object.defineProperty(exports, "getPrimarySuperAdminId", { enumerable: true, get: function () { return admin_1.getPrimarySuperAdminId; } });
Object.defineProperty(exports, "parseSuperAdminIds", { enumerable: true, get: function () { return admin_1.parseSuperAdminIds; } });
