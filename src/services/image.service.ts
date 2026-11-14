import sharp from 'sharp';
import crypto from 'crypto';

sharp.cache({ memory: 50, files: 0, items: 100 });

const memoryBufferCache = new WeakMap<Buffer, Buffer>();

export class ImageService {
  static async optimizeForFastOCR(buffer: Buffer): Promise<Buffer> {
    const cached = memoryBufferCache.get(buffer);
    if (cached) return cached;

    const output = await sharp(buffer, { failOn: 'none', sequentialRead: true })
      .rotate()
      .resize({ width: 1280, withoutEnlargement: true, fastShrinkOnLoad: true, kernel: 'nearest' })
      .grayscale()
      .normalize()
      .webp({ quality: 75, effort: 0 })
      .toBuffer();

    memoryBufferCache.set(buffer, output);
    return output;
  }

  static getImageHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
