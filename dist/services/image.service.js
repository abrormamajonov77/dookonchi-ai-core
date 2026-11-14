"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageService = void 0;
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = __importDefault(require("crypto"));
sharp_1.default.cache({ memory: 50, files: 0, items: 100 });
const memoryBufferCache = new WeakMap();
class ImageService {
    static async optimizeForFastOCR(buffer) {
        const cached = memoryBufferCache.get(buffer);
        if (cached)
            return cached;
        const output = await (0, sharp_1.default)(buffer, { failOn: 'none', sequentialRead: true })
            .rotate()
            .resize({ width: 1280, withoutEnlargement: true, fastShrinkOnLoad: true, kernel: 'nearest' })
            .grayscale()
            .normalize()
            .webp({ quality: 75, effort: 0 })
            .toBuffer();
        memoryBufferCache.set(buffer, output);
        return output;
    }
    static getImageHash(buffer) {
        return crypto_1.default.createHash('sha256').update(buffer).digest('hex');
    }
}
exports.ImageService = ImageService;
