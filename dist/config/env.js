"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const node_dns_1 = __importDefault(require("node:dns"));
const node_net_1 = __importDefault(require("node:net"));
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
node_dns_1.default.setDefaultResultOrder('ipv4first');
node_net_1.default.setDefaultAutoSelectFamily?.(false);
const origLookup = node_dns_1.default.lookup.bind(node_dns_1.default);
node_dns_1.default.lookup = (h, o, cb) => typeof o === 'function' ? origLookup(h, { family: 4 }, o) : origLookup(h, typeof o === 'number' ? { family: 4 } : { ...o, family: 4 }, cb);
dotenv_1.default.config();
const defaults = {
    DATABASE_URL: 'postgresql://user:password@localhost:5432/dookonchi?schema=public',
    BOT_TOKEN: '123456789:TEST_BOT_TOKEN_PLACEHOLDER',
    GEMINI_API_KEY: 'TEST_GEMINI_API_KEY',
    OWNER_TELEGRAM_ID: '123456789'
};
const envSchema = zod_1.z.object({
    DATABASE_URL: zod_1.z.string().url().default(defaults.DATABASE_URL),
    DIRECT_URL: zod_1.z.string().url().optional(),
    BOT_TOKEN: zod_1.z.string().min(1).default(defaults.BOT_TOKEN),
    GEMINI_API_KEY: zod_1.z.string().min(1).default(defaults.GEMINI_API_KEY),
    OWNER_TELEGRAM_ID: zod_1.z.string().regex(/^\d+$/).default(defaults.OWNER_TELEGRAM_ID),
});
const _env = envSchema.safeParse(process.env);
if (!_env.success && process.env.NODE_ENV !== 'test') {
    console.error('❌ Invalid environment variables:', _env.error.format());
    process.exit(1);
}
exports.env = _env.success ? _env.data : envSchema.parse(defaults);
