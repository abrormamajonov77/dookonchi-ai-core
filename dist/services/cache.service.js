"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheService = void 0;
const prisma_1 = require("../database/prisma");
const env_1 = require("../config/env");
const cache_1 = require("../utils/cache");
class CacheService {
    async getSuppliersList(ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const key = (0, cache_1.getSuppliersCacheKey)(cleanOwnerId);
        const cached = cache_1.suppliersListCache.get(key);
        if (cached)
            return cached;
        const suppliers = await prisma_1.prisma.supplier.findMany({
            where: { ownerId: cleanOwnerId, isActive: true },
            orderBy: [{ debtUzs: 'desc' }, { debtUsd: 'desc' }],
        });
        cache_1.suppliersListCache.set(key, suppliers);
        return suppliers;
    }
    async getSupplierNames(ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const suppliers = await this.getSuppliersList(ownerId);
        return suppliers.map((s) => s.name);
    }
    invalidateSupplierNames(ownerId) {
        (0, cache_1.invalidateCache)(ownerId);
    }
}
exports.cacheService = new CacheService();
