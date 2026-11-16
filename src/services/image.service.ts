import sharp from 'sharp';
import crypto from 'crypto';

sharp.cache({ memory: 50, files: 0, items: 100 });
sharp.concurrency(0);

const memoryBufferCache = new WeakMap<Buffer, Buffer>();
const fastSignatureCache = new Map<string, Buffer>();

function getFastSignature(buf: Buffer): string {
  const len = buf.byteLength;
  if (len <= 128) return buf.toString('hex');
  const mid = len >> 1;
  return `${len}:${buf.subarray(0, 32).toString('hex')}:${buf.subarray(mid, mid + 32).toString('hex')}:${buf.subarray(len - 32).toString('hex')}`;
}

export class ImageService {
  /**
   * MODUL 4: Ultra-Fast "Real Skaner Apparati" in-memory pipeline.
   * Converts raw photo buffer to a high-contrast black-and-white scanner JPEG (35-55 KB, <60 KB) in <150ms.
   */
  static async optimizeForFastOCR(rawBuffer: Buffer): Promise<Buffer> {
    const cachedWeak = memoryBufferCache.get(rawBuffer);
    if (cachedWeak) return cachedWeak;

    const sig = getFastSignature(rawBuffer);
    const cachedSig = fastSignatureCache.get(sig);
    if (cachedSig) {
      memoryBufferCache.set(rawBuffer, cachedSig);
      return cachedSig;
    }

    let scannedBuffer = await sharp(rawBuffer, { failOn: 'none', sequentialRead: true })
      .rotate()
      .resize({
        width: 960,
        height: 1100,
        fit: 'inside',
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
        kernel: 'nearest',
      })
      .grayscale()
      .normalize()
      .linear(1.25, -20) // Yozuvlarni skaner kabi tiniq qora, fonni oq qilish
      .jpeg({ quality: 58, progressive: false, mozjpeg: false, optimiseCoding: false })
      .toBuffer();

    if (scannedBuffer.byteLength >= 58 * 1024) {
      scannedBuffer = await sharp(scannedBuffer, { failOn: 'none', sequentialRead: true })
        .resize({ width: 760, height: 960, fit: 'inside', withoutEnlargement: true, kernel: 'nearest' })
        .grayscale()
        .jpeg({ quality: 42, progressive: false, mozjpeg: false, optimiseCoding: false })
        .toBuffer();
    }

    memoryBufferCache.set(rawBuffer, scannedBuffer);
    if (fastSignatureCache.size > 100) {
      const firstKey = fastSignatureCache.keys().next().value;
      if (firstKey) fastSignatureCache.delete(firstKey);
    }
    fastSignatureCache.set(sig, scannedBuffer);
    return scannedBuffer;
  }

  static getImageHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
