"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheService = void 0;
const prisma_1 = require("../database/prisma");
class CacheService {
    supplierNames = null;
    async getSupplierNames() {
        const now = Date.now();
        if (this.supplierNames && this.supplierNames.expiresAt > now)
            return this.supplierNames.data;
        const data = (await prisma_1.prisma.supplier.findMany({ select: { name: true } })).map(s => s.name);
        this.supplierNames = { data, expiresAt: now + 300_000 };
        return data;
    }
    invalidateSupplierNames() { this.supplierNames = null; }
}
exports.cacheService = new CacheService();
