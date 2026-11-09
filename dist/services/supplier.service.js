"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupplierService = void 0;
const prisma_1 = require("../database/prisma");
const translit_service_1 = require("./translit.service");
class SupplierService {
    static normalizeName(name) {
        return translit_service_1.TranslitService.toLatin(name).toLowerCase().trim()
            .replace(/(dan yuk keldi|yuk keldi)$/i, '')
            .replace(/\s+(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|akadan|okadan)(dan|ga|ni|ning)?$/i, '')
            .replace(/(akadan|okadan|aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|dan|ga|ni|ning)$/i, '')
            .trim();
    }
    static async findMatchingSuppliers(rawName, contextComment) {
        const cleanName = this.normalizeName(rawName);
        if (!cleanName)
            return [];
        const suppliers = await prisma_1.prisma.supplier.findMany({ where: { isActive: true, name: { contains: cleanName, mode: 'insensitive' } } });
        if (suppliers.length <= 1)
            return suppliers;
        const exactMatch = suppliers.find(s => this.normalizeName(s.name) === cleanName || s.name.trim().toLowerCase() === rawName.trim().toLowerCase());
        if (exactMatch)
            return [exactMatch];
        if (!contextComment)
            return suppliers;
        const commentLower = contextComment.toLowerCase();
        const exact = suppliers.find(s => s.name.toLowerCase().replace(cleanName, '').trim().split(/\s+/).some(w => w.length > 2 && commentLower.includes(w)));
        return exact ? [exact] : suppliers;
    }
    static cleanSupplierName(name) {
        return name.trim().replace(/(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla)$/gi, '').trim();
    }
    static async getOrMergeSupplier(tx, rawName, exactSupplierId) {
        if (exactSupplierId && exactSupplierId !== 'CREATE_NEW') {
            const s = await tx.supplier.findUnique({ where: { id: exactSupplierId } });
            if (s)
                return s;
        }
        const normalizedName = this.cleanSupplierName(rawName);
        const existing = await tx.supplier.findMany({
            where: {
                isActive: true,
                OR: [
                    { name: { equals: normalizedName, mode: 'insensitive' } },
                    { name: { equals: rawName.trim(), mode: 'insensitive' } },
                    { name: { contains: normalizedName, mode: 'insensitive' } }
                ]
            },
            orderBy: { debtUzs: 'desc' }
        });
        if (!existing.length)
            return tx.supplier.create({ data: { name: rawName, debtUzs: 0 } });
        const primary = existing[0];
        for (const dup of existing.slice(1)) {
            await tx.invoice.updateMany({ where: { supplierId: dup.id }, data: { supplierId: primary.id } });
            await tx.supplierTransaction.updateMany({ where: { supplierId: dup.id }, data: { supplierId: primary.id } });
            await tx.supplierPayment.updateMany({ where: { supplierId: dup.id }, data: { supplierId: primary.id } }).catch(() => { });
            await tx.supplier.update({ where: { id: primary.id }, data: { debtUzs: { increment: dup.debtUzs }, debtUsd: { increment: dup.debtUsd } } });
            await tx.supplier.delete({ where: { id: dup.id } });
        }
        return existing.length > 1 ? (await tx.supplier.findUnique({ where: { id: primary.id } })) || primary : primary;
    }
}
exports.SupplierService = SupplierService;
