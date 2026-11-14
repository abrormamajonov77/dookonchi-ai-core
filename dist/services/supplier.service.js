"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupplierService = void 0;
const prisma_1 = require("../database/prisma");
const translit_service_1 = require("./translit.service");
const cache_service_1 = require("./cache.service");
const formatters_1 = require("../utils/formatters");
const ai_service_1 = require("./ai.service");
class SupplierService {
    static normalizeName(name) {
        return translit_service_1.TranslitService.toLatin(name)
            .toLowerCase()
            .trim()
            .replace(/(dan yuk keldi|yuk keldi)$/i, '')
            .replace(/\s+(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|akadan|okadan)(dan|ga|ni|ning)?$/i, '')
            .replace(/(akadan|okadan|aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|dan|ga|ni|ning)$/i, '')
            .trim();
    }
    static async findMatchingSuppliers(rawName, contextComment) {
        const cleanName = this.normalizeName(rawName);
        if (!cleanName)
            return [];
        const suppliers = await prisma_1.prisma.supplier.findMany({
            where: { isActive: true, name: { contains: cleanName, mode: 'insensitive' } },
        });
        if (suppliers.length <= 1)
            return suppliers;
        const exactMatch = suppliers.find((s) => this.normalizeName(s.name) === cleanName || s.name.trim().toLowerCase() === rawName.trim().toLowerCase());
        if (exactMatch)
            return [exactMatch];
        if (!contextComment)
            return suppliers;
        const commentLower = contextComment.toLowerCase();
        const exact = suppliers.find((s) => s.name
            .toLowerCase()
            .replace(cleanName, '')
            .trim()
            .split(/\s+/)
            .some((w) => w.length > 2 && commentLower.includes(w)));
        return exact ? [exact] : suppliers;
    }
    static cleanSupplierName(name) {
        return name
            .trim()
            .replace(/(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla)$/gi, '')
            .trim();
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
                    { name: { contains: normalizedName, mode: 'insensitive' } },
                ],
            },
            orderBy: { debtUzs: 'desc' },
        });
        if (!existing.length)
            return tx.supplier.create({ data: { name: rawName, debtUzs: 0, debtUsd: 0 } });
        const primary = existing[0];
        for (const dup of existing.slice(1)) {
            await tx.invoice.updateMany({ where: { supplierId: dup.id }, data: { supplierId: primary.id } });
            await tx.invoiceItem.updateMany({ where: { supplierId: dup.id }, data: { supplierId: primary.id } }).catch(() => { });
            await tx.supplierTransaction.updateMany({ where: { supplierId: dup.id }, data: { supplierId: primary.id } });
            await tx.supplierPayment.updateMany({ where: { supplierId: dup.id }, data: { supplierId: primary.id } }).catch(() => { });
            await tx.supplier.update({
                where: { id: primary.id },
                data: { debtUzs: { increment: dup.debtUzs }, debtUsd: { increment: dup.debtUsd } },
            });
            await tx.supplier.delete({ where: { id: dup.id } });
        }
        return existing.length > 1 ? (await tx.supplier.findUnique({ where: { id: primary.id } })) || primary : primary;
    }
    /**
     * MODUL 1: Check if renaming `supplierId` to `newName` conflicts with an existing supplier.
     * If no conflict, updates `Supplier.name` directly while keeping all Foreign Key history intact.
     * If conflict exists, returns `{ status: 'MERGE_REQUIRED', sourceSupplier, targetSupplier }`.
     */
    static async checkOrRenameSupplier(supplierId, rawNewName) {
        const newName = rawNewName.trim();
        if (!newName || newName.length < 2) {
            throw new Error("Ta'minotchi nomi kamida 2 ta harfdan iborat bo'lishi kerak.");
        }
        const sourceSupplier = await prisma_1.prisma.supplier.findUnique({ where: { id: supplierId } });
        if (!sourceSupplier) {
            throw new Error("Ta'minotchi topilmadi.");
        }
        const existingTarget = await prisma_1.prisma.supplier.findFirst({
            where: {
                id: { not: supplierId },
                name: { equals: newName, mode: 'insensitive' },
            },
        });
        if (existingTarget) {
            return {
                status: 'MERGE_REQUIRED',
                sourceSupplier,
                targetSupplier: existingTarget,
            };
        }
        const updatedSupplier = await prisma_1.prisma.supplier.update({
            where: { id: supplierId },
            data: { name: newName },
        });
        cache_service_1.cacheService.invalidateSupplierNames();
        return {
            status: 'RENAMED',
            supplier: updatedSupplier,
        };
    }
    /**
     * MODUL 1: Merge `sourceSupplierId` into `targetSupplierId` inside a Prisma $transaction.
     * Transfers all invoices, invoice items, payments, and transactions, and combines UZS & USD balances.
     */
    static async mergeSuppliers(sourceSupplierId, targetSupplierId) {
        if (sourceSupplierId === targetSupplierId) {
            const same = await prisma_1.prisma.supplier.findUnique({ where: { id: targetSupplierId } });
            if (!same)
                throw new Error("Ta'minotchi topilmadi.");
            return same;
        }
        const merged = await prisma_1.prisma.$transaction(async (tx) => {
            const [source, target] = await Promise.all([
                tx.supplier.findUnique({ where: { id: sourceSupplierId } }),
                tx.supplier.findUnique({ where: { id: targetSupplierId } }),
            ]);
            if (!source || !target) {
                throw new Error("Birlashtiriladigan ta'minotchi topilmadi.");
            }
            await Promise.all([
                tx.invoice.updateMany({
                    where: { supplierId: source.id },
                    data: { supplierId: target.id },
                }),
                tx.invoiceItem.updateMany({
                    where: { supplierId: source.id },
                    data: { supplierId: target.id },
                }),
                tx.supplierTransaction.updateMany({
                    where: { supplierId: source.id },
                    data: { supplierId: target.id },
                }),
                tx.supplierPayment.updateMany({
                    where: { supplierId: source.id },
                    data: { supplierId: target.id },
                }),
            ]);
            const newDebtUzs = Number((Number(target.debtUzs) + Number(source.debtUzs)).toFixed(2));
            const newDebtUsd = Number((Number(target.debtUsd) + Number(source.debtUsd)).toFixed(2));
            const [updatedTarget] = await Promise.all([
                tx.supplier.update({
                    where: { id: target.id },
                    data: {
                        debtUzs: newDebtUzs,
                        debtUsd: newDebtUsd,
                        phone: target.phone || source.phone,
                        isActive: true,
                    },
                }),
                tx.supplier.delete({ where: { id: source.id } }),
            ]);
            return updatedTarget;
        }, { maxWait: 15000, timeout: 30000 });
        cache_service_1.cacheService.invalidateSupplierNames();
        return merged;
    }
    /**
     * MODUL 2, 3, 4: Create a saved Invoice with Verbatim text, InvoiceItems, SupplierTransaction,
     * and update Supplier UZS / USD debt inside a Prisma $transaction.
     */
    static async createInvoiceWithItems(params) {
        const currency = params.currency || 'UZS';
        const math = (0, formatters_1.calculateDiscountedTotal)(params.rawTotal, params.discountInput);
        const createdAt = params.createdAt || new Date();
        const normalizedItems = (params.items || []).map((it) => ai_service_1.InvoiceItemSchema.parse({
            ...it,
            currency: it.currency || currency,
        }));
        const verbatimText = params.verbatimText ||
            (normalizedItems.length > 0 ? (0, ai_service_1.buildVerbatimTableText)(normalizedItems, currency) : '');
        return prisma_1.prisma.$transaction(async (tx) => {
            let supplier = params.supplierId
                ? await tx.supplier.findUnique({ where: { id: params.supplierId } })
                : null;
            if (!supplier) {
                const found = await tx.supplier.findFirst({
                    where: { name: { equals: params.supplierName.trim(), mode: 'insensitive' } },
                });
                if (found) {
                    supplier = await tx.supplier.update({
                        where: { id: found.id },
                        data: currency === 'USD'
                            ? { debtUsd: Number((Number(found.debtUsd) + math.finalTotal).toFixed(2)), isActive: true }
                            : { debtUzs: Number((Number(found.debtUzs) + math.finalTotal).toFixed(2)), isActive: true },
                    });
                }
                else {
                    supplier = await tx.supplier.create({
                        data: {
                            name: params.supplierName.trim(),
                            debtUzs: currency === 'UZS' ? math.finalTotal : 0,
                            debtUsd: currency === 'USD' ? math.finalTotal : 0,
                            isActive: true,
                        },
                    });
                }
            }
            else {
                supplier = await tx.supplier.update({
                    where: { id: supplier.id },
                    data: currency === 'USD'
                        ? { debtUsd: Number((Number(supplier.debtUsd) + math.finalTotal).toFixed(2)), isActive: true }
                        : { debtUzs: Number((Number(supplier.debtUzs) + math.finalTotal).toFixed(2)), isActive: true },
                });
            }
            const invoice = await tx.invoice.create({
                data: {
                    supplierId: supplier.id,
                    invoiceNo: params.invoiceNo || null,
                    originalAmount: math.rawTotal,
                    discountAmount: math.discountAmount,
                    totalAmount: math.finalTotal,
                    currency,
                    verbatimText: verbatimText || null,
                    rawImageUrl: params.rawImageUrl || null,
                    createdAt,
                },
            });
            if (normalizedItems.length > 0) {
                for (const item of normalizedItems) {
                    const itemName = item.rawName || item.productName;
                    const normName = item.normalizedName || translit_service_1.TranslitService.toLatin(itemName).toLowerCase().trim();
                    const searchTokens = translit_service_1.TranslitService.generateSearchTokens(itemName);
                    const itemCurrency = item.currency || currency;
                    const foundProd = await tx.product.findFirst({
                        where: {
                            OR: [
                                { name: { equals: itemName, mode: 'insensitive' } },
                                { searchTokens: { contains: normName, mode: 'insensitive' } },
                            ],
                        },
                        select: { id: true },
                    });
                    const product = foundProd
                        ? await tx.product.update({
                            where: { id: foundProd.id },
                            data: { lastPrice: item.unitPrice, currency: itemCurrency, updatedAt: createdAt },
                            select: { id: true },
                        })
                        : await tx.product.create({
                            data: {
                                name: itemName,
                                searchTokens,
                                lastPrice: item.unitPrice,
                                currency: itemCurrency,
                                createdAt,
                                updatedAt: createdAt,
                            },
                            select: { id: true },
                        });
                    await tx.invoiceItem.create({
                        data: {
                            invoiceId: invoice.id,
                            supplierId: supplier.id,
                            productId: product.id,
                            rawName: itemName,
                            normalizedName: normName,
                            quantity: item.quantity,
                            unit: item.unit || 'dona',
                            unitPrice: item.unitPrice,
                            totalPrice: item.lineTotal,
                            lineTotal: item.lineTotal,
                            currency: itemCurrency,
                            createdAt,
                        },
                    });
                }
            }
            const currentDebtForCurrency = currency === 'USD' ? Number(supplier.debtUsd) : Number(supplier.debtUzs);
            const formattedReceipt = this.buildFormattedReceiptText({
                supplierName: supplier.name,
                date: createdAt,
                verbatimText,
                rawTotal: math.rawTotal,
                discountAmount: math.discountAmount,
                finalTotal: math.finalTotal,
                currency,
                postDebt: currentDebtForCurrency,
            });
            const transaction = await tx.supplierTransaction.create({
                data: {
                    supplierId: supplier.id,
                    invoiceId: invoice.id,
                    type: 'INCOMING_GOODS',
                    sourceType: 'PHOTO',
                    amount: math.finalTotal,
                    originalAmount: math.rawTotal,
                    discountAmount: math.discountAmount,
                    currency,
                    date: createdAt,
                    photoFileId: params.photoFileId || null,
                    formattedReceipt,
                    description: `Nakladnoy ${params.invoiceNo || ''}`.trim(),
                    receiptData: {
                        invoiceId: invoice.id,
                        supplierName: supplier.name,
                        invoiceNo: params.invoiceNo || null,
                        rawTotal: math.rawTotal,
                        discountAmount: math.discountAmount,
                        finalTotal: math.finalTotal,
                        currency,
                        verbatimText,
                        items: normalizedItems,
                    },
                },
            });
            cache_service_1.cacheService.invalidateSupplierNames();
            return { supplier, invoice, transaction };
        }, { maxWait: 10000, timeout: 30000 });
    }
    static buildFormattedReceiptText(params) {
        const cur = params.currency;
        const body = params.verbatimText ? `${params.verbatimText}\n` : '';
        let text = `🧾 ELEKTRON NAKLADNOY\n` +
            `🏢 Ta'minotchi: ${params.supplierName}\n` +
            `📅 Sana: ${(0, formatters_1.formatDate)(params.date)}\n` +
            `💱 Valyuta: ${cur === 'USD' ? 'USD ($)' : "UZS (so'm)"}\n` +
            `-----------------------------\n` +
            `${body}` +
            `-----------------------------\n` +
            `💰 Asl summa: ${(0, formatters_1.formatCurrency)(params.rawTotal, cur)}\n`;
        if (params.discountAmount > 0) {
            text +=
                `🏷 Skidka: -${(0, formatters_1.formatCurrency)(params.discountAmount, cur)}\n` +
                    `💵 Yakuniy summa: ${(0, formatters_1.formatCurrency)(params.finalTotal, cur)}\n`;
        }
        else {
            text += `💵 Yakuniy summa: ${(0, formatters_1.formatCurrency)(params.finalTotal, cur)}\n`;
        }
        text += `📦 Ushbu amaliyotdan keyingi qarz: ${(0, formatters_1.formatCurrency)(params.postDebt, cur)}\n`;
        return text;
    }
    static async resolveInvoiceAndTx(tx, idOrTxId) {
        let invoice = await tx.invoice.findUnique({
            where: { id: idOrTxId },
            include: { supplier: true },
        });
        let supTx = invoice
            ? await tx.supplierTransaction.findFirst({
                where: {
                    OR: [{ invoiceId: invoice.id }, { supplierId: invoice.supplierId, type: 'INCOMING_GOODS' }],
                },
                orderBy: { date: 'desc' },
            })
            : null;
        if (!invoice) {
            supTx = await tx.supplierTransaction.findUnique({ where: { id: idOrTxId } });
            if (supTx?.invoiceId) {
                invoice = await tx.invoice.findUnique({
                    where: { id: supTx.invoiceId },
                    include: { supplier: true },
                });
            }
            if (!invoice && supTx) {
                // Fallback: find closest invoice for this supplier or create one on the fly
                invoice = await tx.invoice.findFirst({
                    where: { supplierId: supTx.supplierId },
                    orderBy: { createdAt: 'desc' },
                    include: { supplier: true },
                });
            }
        }
        if (!invoice) {
            throw new Error('Nakladnoy topilmadi.');
        }
        return { invoice, supTx };
    }
    /**
     * MODUL 2: Update discount (amount or percentage) on a saved Invoice and synchronously recalculate Supplier debt.
     */
    static async updateInvoiceDiscount(invoiceIdOrTxId, discountInput) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const { invoice, supTx } = await this.resolveInvoiceAndTx(tx, invoiceIdOrTxId);
            const rawTotal = Number(invoice.originalAmount ?? invoice.totalAmount);
            const oldFinalTotal = Number(invoice.totalAmount);
            const currency = invoice.currency;
            const math = (0, formatters_1.calculateDiscountedTotal)(rawTotal, discountInput);
            const delta = Number((math.finalTotal - oldFinalTotal).toFixed(2));
            const [updatedSupplier, updatedInvoice] = await Promise.all([
                tx.supplier.update({
                    where: { id: invoice.supplierId },
                    data: currency === 'USD'
                        ? { debtUsd: Number((Number(invoice.supplier.debtUsd) + delta).toFixed(2)) }
                        : { debtUzs: Number((Number(invoice.supplier.debtUzs) + delta).toFixed(2)) },
                }),
                tx.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        originalAmount: math.rawTotal,
                        discountAmount: math.discountAmount,
                        totalAmount: math.finalTotal,
                    },
                }),
            ]);
            if (supTx) {
                const postDebt = currency === 'USD' ? Number(updatedSupplier.debtUsd) : Number(updatedSupplier.debtUzs);
                const formattedReceipt = this.buildFormattedReceiptText({
                    supplierName: updatedSupplier.name,
                    date: supTx.date,
                    verbatimText: invoice.verbatimText,
                    rawTotal: math.rawTotal,
                    discountAmount: math.discountAmount,
                    finalTotal: math.finalTotal,
                    currency,
                    postDebt,
                });
                await tx.supplierTransaction.update({
                    where: { id: supTx.id },
                    data: {
                        originalAmount: math.rawTotal,
                        discountAmount: math.discountAmount,
                        amount: math.finalTotal,
                        formattedReceipt,
                    },
                });
            }
            return {
                invoice: updatedInvoice,
                supplier: updatedSupplier,
                rawTotal: math.rawTotal,
                discountAmount: math.discountAmount,
                finalTotal: math.finalTotal,
                currency,
            };
        }, { maxWait: 15000, timeout: 30000 });
    }
    /**
     * MODUL 2: Clear discount on a saved Invoice (discount = 0, finalTotal = rawTotal) in a $transaction.
     */
    static async clearInvoiceDiscount(invoiceIdOrTxId) {
        return this.updateInvoiceDiscount(invoiceIdOrTxId, 0);
    }
    /**
     * MODUL 2: Manual override of Invoice total (either finalTotal directly, or both rawTotal & finalTotal) in a $transaction.
     */
    static async overrideInvoiceTotal(invoiceIdOrTxId, newTotalOrRawTotal, explicitFinalTotal) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const { invoice, supTx } = await this.resolveInvoiceAndTx(tx, invoiceIdOrTxId);
            const oldFinalTotal = Number(invoice.totalAmount);
            const oldRawTotal = Number(invoice.originalAmount ?? invoice.totalAmount);
            const currency = invoice.currency;
            let rawTotal;
            let finalTotal;
            let discountAmount;
            if (explicitFinalTotal !== undefined && !isNaN(explicitFinalTotal)) {
                rawTotal = Math.max(0, Number(newTotalOrRawTotal.toFixed(2)));
                finalTotal = Math.max(0, Number(explicitFinalTotal.toFixed(2)));
                discountAmount = Math.max(0, Number((rawTotal - finalTotal).toFixed(2)));
            }
            else {
                finalTotal = Math.max(0, Number(newTotalOrRawTotal.toFixed(2)));
                rawTotal = oldRawTotal >= finalTotal ? oldRawTotal : finalTotal;
                discountAmount = Math.max(0, Number((rawTotal - finalTotal).toFixed(2)));
            }
            const delta = Number((finalTotal - oldFinalTotal).toFixed(2));
            const [updatedSupplier, updatedInvoice] = await Promise.all([
                tx.supplier.update({
                    where: { id: invoice.supplierId },
                    data: currency === 'USD'
                        ? { debtUsd: Number((Number(invoice.supplier.debtUsd) + delta).toFixed(2)) }
                        : { debtUzs: Number((Number(invoice.supplier.debtUzs) + delta).toFixed(2)) },
                }),
                tx.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        originalAmount: rawTotal,
                        discountAmount,
                        totalAmount: finalTotal,
                    },
                }),
            ]);
            if (supTx) {
                const postDebt = currency === 'USD' ? Number(updatedSupplier.debtUsd) : Number(updatedSupplier.debtUzs);
                const formattedReceipt = this.buildFormattedReceiptText({
                    supplierName: updatedSupplier.name,
                    date: supTx.date,
                    verbatimText: invoice.verbatimText,
                    rawTotal,
                    discountAmount,
                    finalTotal,
                    currency,
                    postDebt,
                });
                await tx.supplierTransaction.update({
                    where: { id: supTx.id },
                    data: {
                        originalAmount: rawTotal,
                        discountAmount,
                        amount: finalTotal,
                        formattedReceipt,
                    },
                });
            }
            return {
                invoice: updatedInvoice,
                supplier: updatedSupplier,
                rawTotal,
                discountAmount,
                finalTotal,
                currency,
            };
        }, { maxWait: 15000, timeout: 30000 });
    }
    /**
     * MODUL 2 & 3: Toggle Invoice currency between UZS and USD in a Prisma $transaction
     * and move the debt balance from the old currency to the new currency.
     */
    static async toggleInvoiceCurrency(invoiceIdOrTxId) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const { invoice, supTx } = await this.resolveInvoiceAndTx(tx, invoiceIdOrTxId);
            const oldCurrency = invoice.currency;
            const newCurrency = oldCurrency === 'UZS' ? 'USD' : 'UZS';
            const finalTotal = Number(invoice.totalAmount);
            const rawTotal = Number(invoice.originalAmount ?? invoice.totalAmount);
            const discountAmount = Number(invoice.discountAmount ?? 0);
            const newDebtUzs = oldCurrency === 'UZS'
                ? Number((Number(invoice.supplier.debtUzs) - finalTotal).toFixed(2))
                : Number((Number(invoice.supplier.debtUzs) + finalTotal).toFixed(2));
            const newDebtUsd = oldCurrency === 'USD'
                ? Number((Number(invoice.supplier.debtUsd) - finalTotal).toFixed(2))
                : Number((Number(invoice.supplier.debtUsd) + finalTotal).toFixed(2));
            const [updatedSupplier, updatedInvoice] = await Promise.all([
                tx.supplier.update({
                    where: { id: invoice.supplierId },
                    data: { debtUzs: newDebtUzs, debtUsd: newDebtUsd },
                }),
                tx.invoice.update({
                    where: { id: invoice.id },
                    data: { currency: newCurrency },
                }),
                tx.invoiceItem.updateMany({
                    where: { invoiceId: invoice.id },
                    data: { currency: newCurrency },
                }),
            ]);
            if (supTx) {
                const postDebt = newCurrency === 'USD' ? Number(updatedSupplier.debtUsd) : Number(updatedSupplier.debtUzs);
                const formattedReceipt = this.buildFormattedReceiptText({
                    supplierName: updatedSupplier.name,
                    date: supTx.date,
                    verbatimText: invoice.verbatimText,
                    rawTotal,
                    discountAmount,
                    finalTotal,
                    currency: newCurrency,
                    postDebt,
                });
                await tx.supplierTransaction.update({
                    where: { id: supTx.id },
                    data: {
                        currency: newCurrency,
                        formattedReceipt,
                    },
                });
            }
            return {
                invoice: updatedInvoice,
                supplier: updatedSupplier,
                rawTotal,
                discountAmount,
                finalTotal,
                currency: newCurrency,
            };
        }, { maxWait: 15000, timeout: 30000 });
    }
    /**
     * MODUL 3.3: Format Debtors / Suppliers list with separate UZS & USD balances and two-line JAMI QARZ summary.
     */
    static async getFormattedDebtorsReport(page = 1, perPage = 10) {
        const [totalCount, aggregateResult] = await Promise.all([
            prisma_1.prisma.supplier.count({ where: { isActive: true } }),
            prisma_1.prisma.supplier.aggregate({
                where: { isActive: true },
                _sum: { debtUzs: true, debtUsd: true },
            }),
        ]);
        const totalPages = Math.ceil(totalCount / perPage) || 1;
        const currentPage = Math.max(1, Math.min(page, totalPages));
        const suppliers = await prisma_1.prisma.supplier.findMany({
            where: { isActive: true },
            orderBy: [{ debtUzs: 'desc' }, { debtUsd: 'desc' }],
            skip: (currentPage - 1) * perPage,
            take: perPage,
            select: { id: true, name: true, debtUzs: true, debtUsd: true },
        });
        const totalUzs = Number(Number(aggregateResult._sum.debtUzs || 0).toFixed(2));
        const totalUsd = Number(Number(aggregateResult._sum.debtUsd || 0).toFixed(2));
        const listLines = suppliers.length
            ? suppliers
                .map((sup) => (0, formatters_1.formatSupplierDebtLine)(sup.name, sup.debtUzs, sup.debtUsd, '🏢 '))
                .join('\n')
            : "Hozircha ta'minotchilar yo'q.";
        const summaryBlock = (0, formatters_1.formatTotalDebtBlock)(totalUzs, totalUsd);
        const text = `📦 **Ta'minotchilar (Sahifa ${currentPage}/${totalPages})**\n\n` +
            `${listLines}\n\n` +
            `${summaryBlock}`;
        return {
            text,
            suppliers,
            totalUzs,
            totalUsd,
            currentPage,
            totalPages,
        };
    }
}
exports.SupplierService = SupplierService;
