import { prisma } from '../database/prisma';
import { env } from '../config/env';
import { getSuppliersCacheKey, invalidateCache, suppliersListCache } from '../utils/cache';

class CacheService {
  async getSuppliersList(ownerId: string = env.OWNER_TELEGRAM_ID) {
    const cleanOwnerId = String(ownerId || env.OWNER_TELEGRAM_ID).trim();
    const key = getSuppliersCacheKey(cleanOwnerId);
    const cached = suppliersListCache.get(key);
    if (cached) return cached;

    const suppliers = await prisma.supplier.findMany({
      where: { ownerId: cleanOwnerId, isActive: true },
      orderBy: [{ debtUzs: 'desc' }, { debtUsd: 'desc' }],
    });
    suppliersListCache.set(key, suppliers);
    return suppliers;
  }

  async getSupplierNames(ownerId: string = env.OWNER_TELEGRAM_ID): Promise<string[]> {
    const suppliers = await this.getSuppliersList(ownerId);
    return suppliers.map((s: any) => s.name);
  }

  invalidateSupplierNames(ownerId?: string) {
    invalidateCache(ownerId);
  }
}

export const cacheService = new CacheService();
