import { prisma } from '../database/prisma';
import { env } from '../config/env';

class CacheService {
  private supplierNamesByOwner = new Map<string, { data: string[]; expiresAt: number }>();

  async getSupplierNames(ownerId: string = env.OWNER_TELEGRAM_ID): Promise<string[]> {
    const cleanOwnerId = String(ownerId || env.OWNER_TELEGRAM_ID).trim();
    const now = Date.now();
    const cached = this.supplierNamesByOwner.get(cleanOwnerId);
    if (cached && cached.expiresAt > now) return cached.data;
    const data = (
      await prisma.supplier.findMany({
        where: { ownerId: cleanOwnerId, isActive: true },
        select: { name: true },
      })
    ).map((s) => s.name);
    this.supplierNamesByOwner.set(cleanOwnerId, { data, expiresAt: now + 300_000 });
    return data;
  }

  invalidateSupplierNames(ownerId?: string) {
    if (ownerId) {
      this.supplierNamesByOwner.delete(String(ownerId).trim());
    } else {
      this.supplierNamesByOwner.clear();
    }
  }
}

export const cacheService = new CacheService();
