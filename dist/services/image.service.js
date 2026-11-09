"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageService = void 0;
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = __importDefault(require("crypto"));
class ImageService {
    static async optimizeForFastOCR(buffer) {
        return (0, sharp_1.default)(buffer)
            .rotate()
            .resize({ width: 1400, withoutEnlargement: true })
            .grayscale()
            .normalize()
            .jpeg({ quality: 75, progressive: true })
            .toBuffer();
    }
    static getImageHash(buffer) {
        return crypto_1.default.createHash('sha256').update(buffer).digest('hex');
    }
}
exports.ImageService = ImageService;
