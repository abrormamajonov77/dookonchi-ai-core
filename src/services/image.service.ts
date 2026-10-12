import sharp from 'sharp';

export class ImageService {
  /**
   * Preprocesses an image to improve OCR accuracy.
   * - Auto-orients based on EXIF
   * - Converts to grayscale
   * - Enhances contrast using linear adjustments
   */

  static async optimizeForFastOCR(buffer: Buffer): Promise<Buffer> {
    return await sharp(buffer)
      .rotate() // Orientatsiyani avto-to'g'irlash
      .resize({ width: 1400, withoutEnlargement: true }) // Matn aniq ko'rinadigan optimal eni
      .grayscale() // Ranglarni olib tashlash (kontrast oshadi, hajm 3 baravar kichrayadi)
      .normalize() // Matn va fon orasidagi kontrastni maksimal oshirish
      .jpeg({ quality: 75, progressive: true })
      .toBuffer();
  }

  static getImageHash(buffer: Buffer): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
