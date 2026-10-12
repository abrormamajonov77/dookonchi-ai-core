import { prisma } from '../database/prisma';
import { TranslitService } from './translit.service';

export class SupplierService {
  /**
   * Cleans and normalizes the supplier name for searching.
   */
  static normalizeName(name: string): string {
    let cleanName = name.replace(/(aka|jon|xon|bek|dan|ga|ni|ning|dan yuk keldi|yuk keldi)$/i, '').trim();
    return TranslitService.toLatin(cleanName).toLowerCase();
  }

  /**
   * Finds matching suppliers by normalized name and smart context matching.
   */
  static async findMatchingSuppliers(rawName: string, contextComment?: string) {
    const cleanName = this.normalizeName(rawName);
    if (!cleanName) return [];

    const suppliers = await prisma.supplier.findMany({
      where: {
        isActive: true,
        name: {
          contains: cleanName,
          mode: 'insensitive'
        }
      }
    });

    if (suppliers.length <= 1) return suppliers;

    // Smart Context Matching
    if (contextComment) {
      const commentLower = contextComment.toLowerCase();
      
      // If a supplier's name contains a word found in the comment, prioritize it
      const exactContextMatch = suppliers.find(s => {
        const sNameLower = s.name.toLowerCase();
        // check if name has extra words that match the comment (e.g. "Azamat Sir")
        const extraWords = sNameLower.replace(cleanName, '').trim().split(/\s+/);
        return extraWords.some(w => w.length > 2 && commentLower.includes(w));
      });

      if (exactContextMatch) {
        return [exactContextMatch]; // Prioritize this one as exact
      }
    }

    return suppliers;
  }

  static cleanSupplierName(name: string): string {
    return name
      .trim()
      .replace(/(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla)$/gi, '')
      .trim();
  }

  static async getOrMergeSupplier(tx: any, rawName: string, exactSupplierId?: string) {
    if (exactSupplierId && exactSupplierId !== 'CREATE_NEW') {
      const s = await tx.supplier.findUnique({ where: { id: exactSupplierId } });
      if (s) return s;
    }

    const normalizedName = this.cleanSupplierName(rawName);

    const existingSuppliers = await tx.supplier.findMany({
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

    if (existingSuppliers.length === 0) {
      return await tx.supplier.create({ data: { name: rawName, debtUzs: 0 } });
    }

    const primarySupplier = existingSuppliers[0];

    if (existingSuppliers.length > 1) {
      for (let i = 1; i < existingSuppliers.length; i++) {
        const dup = existingSuppliers[i];
        
        await tx.supplierTransaction.updateMany({
          where: { supplierId: dup.id },
          data: { supplierId: primarySupplier.id }
        });
        
        await tx.supplierPayment.updateMany({
           where: { supplierId: dup.id },
           data: { supplierId: primarySupplier.id }
        }).catch(() => {}); // Optional in case model doesn't exist
        
        await tx.supplier.update({
          where: { id: primarySupplier.id },
          data: { debtUzs: { increment: dup.debtUzs } }
        });
        
        await tx.supplier.delete({ where: { id: dup.id } });
      }
      
      // refresh primary supplier debt after merge
      const refreshed = await tx.supplier.findUnique({ where: { id: primarySupplier.id } });
      return refreshed || primarySupplier;
    }

    return primarySupplier;
  }
}
