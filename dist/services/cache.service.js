"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheService = void 0;
const prisma_1 = require("../database/prisma");
const env_1 = require("../config/env");
class CacheService {
    supplierNamesByOwner = new Map();
    async getSupplierNames(ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const now = Date.now();
        const cached = this.supplierNamesByOwner.get(cleanOwnerId);
        if (cached && cached.expiresAt > now)
            return cached.data;
        const data = (await prisma_1.prisma.supplier.findMany({
            where: { ownerId: cleanOwnerId, isActive: true },
            select: { name: true },
        })).map((s) => s.name);
        this.supplierNamesByOwner.set(cleanOwnerId, { data, expiresAt: now + 300_000 });
        return data;
    }
    invalidateSupplierNames(ownerId) {
        if (ownerId) {
            this.supplierNamesByOwner.delete(String(ownerId).trim());
        }
        else {
            this.supplierNamesByOwner.clear();
        }
    }
}
exports.cacheService = new CacheService();
