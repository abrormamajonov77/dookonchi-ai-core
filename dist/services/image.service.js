"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageService = void 0;
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = __importDefault(require("crypto"));
sharp_1.default.cache({ memory: 50, files: 0, items: 100 });
sharp_1.default.concurrency(0);
const memoryBufferCache = new WeakMap();
const fastSignatureCache = new Map();
function getFastSignature(buf) {
    const len = buf.byteLength;
    if (len <= 128)
        return buf.toString('hex');
    const mid = len >> 1;
    return `${len}:${buf.subarray(0, 32).toString('hex')}:${buf.subarray(mid, mid + 32).toString('hex')}:${buf.subarray(len - 32).toString('hex')}`;
}
class ImageService {
    /**
     * Lightweight natural color image optimization for Gemini Vision OCR:
     * preserves original colors and fine print legibility without B&W/contrast burn.
     */
    static async optimizeForFastOCR(rawBuffer) {
        if (!rawBuffer || rawBuffer.byteLength === 0) {
            throw new Error("Rasm fayli bo'sh");
        }
        const cachedWeak = memoryBufferCache.get(rawBuffer);
        if (cachedWeak)
            return cachedWeak;
        const sig = getFastSignature(rawBuffer);
        const cachedSig = fastSignatureCache.get(sig);
        if (cachedSig) {
            memoryBufferCache.set(rawBuffer, cachedSig);
            return cachedSig;
        }
        const ocrBuffer = await (0, sharp_1.default)(rawBuffer, { failOn: 'none' })
            .rotate() // Faqat EXIF bo'yicha to'g'ri tomonga aylantirish
            .resize({ width: 1600, withoutEnlargement: true }) // Asl rangli tiniqlikni saqlash
            .jpeg({ quality: 85, mozjpeg: true })
            .toBuffer();
        memoryBufferCache.set(rawBuffer, ocrBuffer);
        if (fastSignatureCache.size > 100) {
            const firstKey = fastSignatureCache.keys().next().value;
            if (firstKey)
                fastSignatureCache.delete(firstKey);
        }
        fastSignatureCache.set(sig, ocrBuffer);
        return ocrBuffer;
    }
    static getImageHash(buffer) {
        return crypto_1.default.createHash('sha256').update(buffer).digest('hex');
    }
}
exports.ImageService = ImageService;
