"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageService = void 0;
exports.createUltraBrightXeroxImage = createUltraBrightXeroxImage;
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
/**
 * 5-MUAMMO: Ultra-Bright HD Xerox Scanner (`createUltraBrightXeroxImage`).
 * - Rasmni kichraytirib xiralashtirmaydi, aksincha 1800px HD o'lchamda (`lanczos3`) kattalashtiradi,
 *   oq-qora kserokopiya kontrastini va yorug'ligini oshiradi (`brightness: 1.15`, `linear(1.85, -75)`),
 *   harflarni o'tkirlashtiradi (`sharpen`) va `quality: 92` bilan tiniq HD kserokopiya tayyorlaydi.
 */
async function createUltraBrightXeroxImage(rawBuffer) {
    if (!rawBuffer || rawBuffer.byteLength === 0) {
        throw new Error("Rasm fayli bo'sh");
    }
    const xeroxBuffer = await (0, sharp_1.default)(rawBuffer, { failOn: 'none' })
        .rotate() // EXIF bo'yicha avtomatik to'g'rilash
        .resize({ width: 1800, withoutEnlargement: false, kernel: 'lanczos3' }) // 2x HD kattalashtirish va tiniqlashtirish
        .grayscale() // Haqiqiy oq-qora kserokopiya rejimi
        .normalize() // Yorug'lik diapazonini 100% ga yoyish
        .modulate({ brightness: 1.15 }) // Qorong'i joylarni va soyalarni oqartirish
        .linear(1.85, -75) // Orqa fonni qordek oppoq, yozuvlarni qop-qora qilish
        .sharpen({ sigma: 1.2, m1: 1.5, m2: 0.7 }) // Mayda raqamlar va qo'lyozma chiziqlarini o'tkirlashtirish
        .jpeg({ quality: 92, mozjpeg: true }) // Yuqori sifatda saqlash (xiralashtirmasdan!)
        .toBuffer();
    return xeroxBuffer;
}
class ImageService {
    /**
     * 5-MUAMMO: Ultra-Bright HD Xerox Scanner (1800px, quality 92).
     */
    static async createUltraBrightXeroxImage(rawBuffer) {
        return createUltraBrightXeroxImage(rawBuffer);
    }
    /**
     * Fast lightweight B&W scanner pipeline (kept for backward compatibility).
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
        let scannedBuffer = await (0, sharp_1.default)(rawBuffer, { failOn: 'none', sequentialRead: true })
            .rotate() // EXIF bo'yicha avtomatik to'g'rilash
            .resize({
            width: 880,
            height: 1050,
            fit: 'inside',
            withoutEnlargement: true,
            fastShrinkOnLoad: true,
            kernel: 'nearest',
        })
            .grayscale()
            .normalize()
            .linear(1.3, -25) // Yozuvlarni tiniq qora, fonni toza oq skaner qilish
            .jpeg({ quality: 55, progressive: false, mozjpeg: false, optimiseCoding: false })
            .toBuffer();
        if (scannedBuffer.byteLength > 45 * 1024) {
            scannedBuffer = await (0, sharp_1.default)(scannedBuffer, { failOn: 'none', sequentialRead: true })
                .resize({ width: 720, height: 900, fit: 'inside', withoutEnlargement: true, kernel: 'nearest' })
                .grayscale()
                .jpeg({ quality: 32, progressive: false, mozjpeg: false, optimiseCoding: false })
                .toBuffer();
        }
        if (scannedBuffer.byteLength > 45 * 1024) {
            scannedBuffer = await (0, sharp_1.default)(scannedBuffer, { failOn: 'none', sequentialRead: true })
                .resize({ width: 600, height: 760, fit: 'inside', withoutEnlargement: true, kernel: 'nearest' })
                .grayscale()
                .jpeg({ quality: 24, progressive: false, mozjpeg: false, optimiseCoding: false })
                .toBuffer();
        }
        memoryBufferCache.set(rawBuffer, scannedBuffer);
        if (fastSignatureCache.size > 100) {
            const firstKey = fastSignatureCache.keys().next().value;
            if (firstKey)
                fastSignatureCache.delete(firstKey);
        }
        fastSignatureCache.set(sig, scannedBuffer);
        return scannedBuffer;
    }
    static getImageHash(buffer) {
        return crypto_1.default.createHash('sha256').update(buffer).digest('hex');
    }
}
exports.ImageService = ImageService;
