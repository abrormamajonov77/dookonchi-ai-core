import { prisma } from '../database/prisma';

class CacheService {
  private supplierNames: { data: string[]; expiresAt: number } | null = null;

  async getSupplierNames(): Promise<string[]> {
    const now = Date.now();
    if (this.supplierNames && this.supplierNames.expiresAt > now) return this.supplierNames.data;
    const data = (await prisma.supplier.findMany({ select: { name: true } })).map(s => s.name);
    this.supplierNames = { data, expiresAt: now + 300_000 };
    return data;
  }

  invalidateSupplierNames() { this.supplierNames = null; }
}

export const cacheService = new CacheService();
