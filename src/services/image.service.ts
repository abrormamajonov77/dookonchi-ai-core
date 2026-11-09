import sharp from 'sharp';
import crypto from 'crypto';

export class ImageService {
  static async optimizeForFastOCR(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .rotate()
      .resize({ width: 1400, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .jpeg({ quality: 75, progressive: true })
      .toBuffer();
  }

  static getImageHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
