import { prisma } from '../database/prisma';

interface CacheItem<T> {
  data: T;
  expiresAt: number;
}

class CacheService {
  private supplierNames: CacheItem<string[]> | null = null;
  private CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  async getSupplierNames(): Promise<string[]> {
    const now = Date.now();
    if (this.supplierNames && this.supplierNames.expiresAt > now) {
      return this.supplierNames.data;
    }

    const suppliers = await prisma.supplier.findMany({ select: { name: true } });
    const names = suppliers.map(s => s.name);
    
    this.supplierNames = {
      data: names,
      expiresAt: now + this.CACHE_TTL_MS
    };

    return names;
  }

  invalidateSupplierNames() {
    this.supplierNames = null;
  }
}

export const cacheService = new CacheService();
