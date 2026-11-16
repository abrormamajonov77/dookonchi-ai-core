"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupplierService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../database/prisma");
const env_1 = require("../config/env");
const translit_service_1 = require("./translit.service");
const cache_service_1 = require("./cache.service");
const formatters_1 = require("../utils/formatters");
const ai_service_1 = require("./ai.service");
class SupplierService {
    static computeImageHash(buffer) {
        return crypto_1.default.createHash('sha256').update(buffer).digest('hex');
    }
    static computeContentFingerprint(params) {
        const ownerPrefix = params.ownerId ? `${String(params.ownerId).trim()}|` : '';
        const normSupp = this.normalizeName(params.supplierName || "noma'lum");
        const items = params.items || params.rows || [];
        const first3 = items
            .slice(0, 3)
            .map((it) => {
            if (typeof it === 'string') {
                return translit_service_1.TranslitService.toLatin(it).toLowerCase().replace(/\s+/g, ' ').trim();
            }
            const n = translit_service_1.TranslitService.toLatin(it.normalizedName || it.rawName || it.productName || '')
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .trim();
            const q = Number(it.quantity || 1);
            const tot = Number(it.lineTotal ?? it.totalPrice ?? 0).toFixed(2);
            return `${n}:${q}:${tot}`;
        })
            .join(';');
        const rawStr = `${ownerPrefix}${normSupp}|${params.currency}|${Number(params.finalTotal || 0).toFixed(2)}|${items.length}|${first3}`;
        return crypto_1.default.createHash('sha256').update(rawStr).digest('hex');
    }
    static formatDuplicateWarningMessage(existingInvoice) {
        const cur = existingInvoice.currency === 'USD' ? 'USD' : 'UZS';
        const supName = existingInvoice.supplier?.name || "Noma'lum";
        const dt = (0, formatters_1.formatDate)(existingInvoice.createdAt);
        return (`⛔️ DIQQAT! Bu nakladnoy oldin kiritilgan, ikkinchi marta kiritish mumkin emas!\n` +
            `🏢 Ta'minotchi: ${supName}\n` +
            `💰 Summasi: ${(0, formatters_1.formatCurrency)(existingInvoice.totalAmount, cur)}\n` +
            `🕒 Oldin kiritilgan vaqti: ${dt}`);
    }
    static async checkDuplicateInvoice(params) {
        const ownerId = String(params.ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        if (params.imageHash) {
            const byHash = await prisma_1.prisma.invoice.findFirst({
                where: { ownerId, imageHash: params.imageHash },
                include: { supplier: true },
                orderBy: { createdAt: 'desc' },
            });
            if (byHash) {
                return {
                    isDuplicate: true,
                    stage: 'IMAGE_HASH',
                    existingInvoice: byHash,
                    warningText: this.formatDuplicateWarningMessage(byHash),
                };
            }
        }
        if (params.contentFingerprint) {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const byFingerprint = await prisma_1.prisma.invoice.findFirst({
                where: {
                    ownerId,
                    contentFingerprint: params.contentFingerprint,
                    createdAt: { gte: thirtyDaysAgo },
                },
                include: { supplier: true },
                orderBy: { createdAt: 'desc' },
            });
            if (byFingerprint) {
                return {
                    isDuplicate: true,
                    stage: 'CONTENT_FINGERPRINT',
                    existingInvoice: byFingerprint,
                    warningText: this.formatDuplicateWarningMessage(byFingerprint),
                };
            }
        }
        return {
            isDuplicate: false,
            stage: null,
            existingInvoice: null,
            warningText: null,
        };
    }
    static normalizeName(name) {
        return translit_service_1.TranslitService.toLatin(name)
            .toLowerCase()
            .trim()
            .replace(/(dan yuk keldi|yuk keldi)$/i, '')
            .replace(/\s+(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|akadan|okadan)(dan|ga|ni|ning)?$/i, '')
            .replace(/(akadan|okadan|aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|dan|ga|ni|ning)$/i, '')
            .trim();
    }
    static async findMatchingSuppliers(rawName, contextComment, ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const cleanName = this.normalizeName(rawName);
        if (!cleanName)
            return [];
        const suppliers = await prisma_1.prisma.supplier.findMany({
            where: { ownerId: cleanOwnerId, isActive: true, name: { contains: cleanName, mode: 'insensitive' } },
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
    static async getOrMergeSupplier(tx, rawName, exactSupplierId, ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        if (exactSupplierId && exactSupplierId !== 'CREATE_NEW') {
            const s = await tx.supplier.findFirst({ where: { id: exactSupplierId, ownerId: cleanOwnerId } });
            if (s)
                return s;
        }
        const normalizedName = this.cleanSupplierName(rawName);
        const existing = await tx.supplier.findMany({
            where: {
                ownerId: cleanOwnerId,
                isActive: true,
                OR: [
                    { name: { equals: normalizedName, mode: 'insensitive' } },
                    { name: { equals: rawName.trim(), mode: 'insensitive' } },
                    { name: { contains: normalizedName, mode: 'insensitive' } },
                ],
            },
            orderBy: { debtUzs: 'desc' },
        });
        if (!existing.length) {
            return tx.supplier.create({
                data: { ownerId: cleanOwnerId, name: rawName.trim(), debtUzs: 0, debtUsd: 0 },
            });
        }
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
    static async checkOrRenameSupplier(supplierId, rawNewName, ownerId) {
        const newName = rawNewName.trim();
        if (!newName || newName.length < 2) {
            throw new Error("Ta'minotchi nomi kamida 2 ta harfdan iborat bo'lishi kerak.");
        }
        const sourceSupplier = await prisma_1.prisma.supplier.findUnique({ where: { id: supplierId } });
        if (!sourceSupplier) {
            throw new Error("Ta'minotchi topilmadi.");
        }
        const effectiveOwnerId = String(ownerId || sourceSupplier.ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const existingTarget = await prisma_1.prisma.supplier.findFirst({
            where: {
                ownerId: effectiveOwnerId,
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
        cache_service_1.cacheService.invalidateSupplierNames(effectiveOwnerId);
        return {
            status: 'RENAMED',
            supplier: updatedSupplier,
        };
    }
    static async mergeSuppliers(sourceSupplierId, targetSupplierId, ownerId) {
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
            if (ownerId && (source.ownerId !== ownerId || target.ownerId !== ownerId)) {
                throw new Error("Boshqa foydalanuvchi ta'minotchisini birlashtirish mumkin emas.");
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
        cache_service_1.cacheService.invalidateSupplierNames(merged.ownerId);
        return merged;
    }
    static async createInvoiceWithItems(params) {
        const ownerId = String(params.ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const currency = params.currency || 'UZS';
        const createdAt = params.createdAt || new Date();
        const normalizedItems = (params.items || []).map((it) => ai_service_1.InvoiceItemSchema.parse({
            ...it,
            currency: it.currency || currency,
        }));
        const itemsSum = normalizedItems.reduce((acc, it) => acc + Number(it.lineTotal || 0), 0);
        const reconciled = params.printedFinalTotal !== undefined || params.discountPercent !== undefined
            ? (0, formatters_1.reconcileInvoiceTotals)({
                rows: normalizedItems,
                itemsSum,
                subtotalBeforeDiscount: params.rawTotal,
                discountPercent: params.discountPercent,
                discountAmount: params.discountInput,
                printedFinalTotal: params.printedFinalTotal,
            })
            : (0, formatters_1.calculateDiscountedTotal)(params.rawTotal, params.discountInput);
        const math = {
            rawTotal: reconciled.rawTotal,
            discountAmount: reconciled.discountAmount,
            finalTotal: reconciled.finalTotal,
        };
        const paymentType = params.paymentType || 'CREDIT';
        const paidCashAmount = paymentType === 'CASH'
            ? math.finalTotal
            : paymentType === 'PARTIAL'
                ? Math.min(math.finalTotal, Math.max(0, Number((params.paidCashAmount || 0).toFixed(2))))
                : 0;
        const creditAmount = paymentType === 'CASH'
            ? 0
            : paymentType === 'PARTIAL'
                ? Math.max(0, Number((math.finalTotal - paidCashAmount).toFixed(2)))
                : math.finalTotal;
        const imageHash = params.imageHash || null;
        const contentFingerprint = params.contentFingerprint ||
            this.computeContentFingerprint({
                ownerId,
                supplierName: params.supplierName,
                currency,
                finalTotal: math.finalTotal,
                items: normalizedItems,
            });
        if (!params.forceOverrideDuplicate) {
            const dupCheck = await this.checkDuplicateInvoice({ ownerId, imageHash, contentFingerprint });
            if (dupCheck.isDuplicate && dupCheck.existingInvoice) {
                return {
                    isDuplicate: true,
                    duplicateStage: dupCheck.stage,
                    warningText: dupCheck.warningText,
                    existingInvoice: dupCheck.existingInvoice,
                    supplier: dupCheck.existingInvoice.supplier,
                    invoice: dupCheck.existingInvoice,
                    transaction: null,
                };
            }
        }
        const verbatimText = params.verbatimText ||
            (normalizedItems.length > 0 ? (0, ai_service_1.buildVerbatimTableText)(normalizedItems, currency) : '');
        return prisma_1.prisma.$transaction(async (tx) => {
            let supplier = params.supplierId
                ? await tx.supplier.findFirst({ where: { id: params.supplierId, ownerId } })
                : null;
            if (!supplier) {
                const found = await tx.supplier.findFirst({
                    where: { ownerId, name: { equals: params.supplierName.trim(), mode: 'insensitive' } },
                });
                if (found) {
                    supplier = await tx.supplier.update({
                        where: { id: found.id },
                        data: currency === 'USD'
                            ? { debtUsd: Number((Number(found.debtUsd) + creditAmount).toFixed(2)), isActive: true }
                            : { debtUzs: Number((Number(found.debtUzs) + creditAmount).toFixed(2)), isActive: true },
                    });
                }
                else {
                    supplier = await tx.supplier.create({
                        data: {
                            ownerId,
                            name: params.supplierName.trim(),
                            debtUzs: currency === 'UZS' ? creditAmount : 0,
                            debtUsd: currency === 'USD' ? creditAmount : 0,
                            isActive: true,
                        },
                    });
                }
            }
            else {
                supplier = await tx.supplier.update({
                    where: { id: supplier.id },
                    data: currency === 'USD'
                        ? { debtUsd: Number((Number(supplier.debtUsd) + creditAmount).toFixed(2)), isActive: true }
                        : { debtUzs: Number((Number(supplier.debtUzs) + creditAmount).toFixed(2)), isActive: true },
                });
            }
            const invoice = await tx.invoice.create({
                data: {
                    ownerId,
                    supplierId: supplier.id,
                    invoiceNo: params.invoiceNo || null,
                    originalAmount: math.rawTotal,
                    discountAmount: math.discountAmount,
                    totalAmount: math.finalTotal,
                    currency,
                    paymentType,
                    paidCashAmount,
                    creditAmount,
                    imageHash,
                    contentFingerprint,
                    verbatimText: verbatimText || null,
                    rawImageUrl: params.rawImageUrl || null,
                    createdAt,
                },
            });
            if (paidCashAmount > 0) {
                await tx.cashTransaction.create({
                    data: {
                        ownerId,
                        partyName: supplier.name,
                        amount: paidCashAmount,
                        currency,
                        items: JSON.stringify(normalizedItems),
                        createdBy: ownerId,
                        createdAt,
                    },
                });
            }
            if (normalizedItems.length > 0) {
                for (const item of normalizedItems) {
                    const itemName = item.rawName || item.productName;
                    const normName = item.normalizedName || translit_service_1.TranslitService.toLatin(itemName).toLowerCase().trim();
                    const searchTokens = translit_service_1.TranslitService.generateSearchTokens(itemName);
                    const itemCurrency = item.currency || currency;
                    const foundProd = await tx.product.findFirst({
                        where: {
                            ownerId,
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
                                ownerId,
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
                            ownerId,
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
                    ownerId,
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
                    description: `Nakladnoy ${params.invoiceNo || ''} (${paymentType})`.trim(),
                    receiptData: {
                        invoiceId: invoice.id,
                        supplierName: supplier.name,
                        invoiceNo: params.invoiceNo || null,
                        rawTotal: math.rawTotal,
                        discountAmount: math.discountAmount,
                        finalTotal: math.finalTotal,
                        paymentType,
                        paidCashAmount,
                        creditAmount,
                        currency,
                        verbatimText,
                        items: normalizedItems,
                    },
                },
            });
            cache_service_1.cacheService.invalidateSupplierNames(ownerId);
            return {
                isDuplicate: false,
                duplicateStage: null,
                warningText: null,
                existingInvoice: null,
                supplier,
                invoice,
                transaction,
            };
        }, { maxWait: 15000, timeout: 30000 });
    }
    static async recordSupplierPayment(params) {
        const ownerId = String(params.ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const currency = params.currency || 'UZS';
        const isUsd = currency === 'USD';
        const amount = Math.max(0, Number(Math.abs(params.amount || 0).toFixed(2)));
        const createdAt = params.createdAt || new Date();
        const commentText = params.comment || params.note || "Ta'minotchiga to'lov";
        return prisma_1.prisma.$transaction(async (tx) => {
            const supplier = await this.getOrMergeSupplier(tx, params.supplierName, params.supplierId, ownerId);
            const newDebtUzs = Number((Number(supplier.debtUzs) - (isUsd ? 0 : amount)).toFixed(2));
            const newDebtUsd = Number((Number(supplier.debtUsd) - (isUsd ? amount : 0)).toFixed(2));
            const [payment, transaction, updatedSupplier] = await Promise.all([
                tx.supplierPayment.create({
                    data: {
                        ownerId,
                        supplierId: supplier.id,
                        amount,
                        currency,
                        comment: commentText,
                        createdAt,
                    },
                }),
                tx.supplierTransaction.create({
                    data: {
                        ownerId,
                        supplierId: supplier.id,
                        type: 'PAYMENT',
                        amount,
                        currency,
                        date: createdAt,
                        sourceType: 'MANUAL',
                        description: commentText,
                    },
                }),
                tx.supplier.update({
                    where: { id: supplier.id },
                    data: { debtUzs: newDebtUzs, debtUsd: newDebtUsd },
                }),
            ]);
            cache_service_1.cacheService.invalidateSupplierNames(ownerId);
            return { supplier: updatedSupplier, payment, transaction };
        }, { maxWait: 15000, timeout: 30000 });
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
    static async resolveInvoiceAndTx(tx, idOrTxId, ownerId) {
        let invoice = await tx.invoice.findUnique({
            where: { id: idOrTxId },
            include: { supplier: true },
        });
        if (invoice && ownerId && invoice.ownerId !== ownerId) {
            throw new Error("Ruxsat yo'q.");
        }
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
            if (supTx && ownerId && supTx.ownerId !== ownerId) {
                throw new Error("Ruxsat yo'q.");
            }
            if (supTx?.invoiceId) {
                invoice = await tx.invoice.findUnique({
                    where: { id: supTx.invoiceId },
                    include: { supplier: true },
                });
            }
            if (!invoice && supTx) {
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
    static async updateInvoiceDiscount(invoiceIdOrTxId, discountInput, ownerId) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const { invoice, supTx } = await this.resolveInvoiceAndTx(tx, invoiceIdOrTxId, ownerId);
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
    static async clearInvoiceDiscount(invoiceIdOrTxId, ownerId) {
        return this.updateInvoiceDiscount(invoiceIdOrTxId, 0, ownerId);
    }
    static async overrideInvoiceTotal(invoiceIdOrTxId, newTotalOrRawTotal, explicitFinalTotal, ownerId) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const { invoice, supTx } = await this.resolveInvoiceAndTx(tx, invoiceIdOrTxId, ownerId);
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
    static async toggleInvoiceCurrency(invoiceIdOrTxId, ownerId) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const { invoice, supTx } = await this.resolveInvoiceAndTx(tx, invoiceIdOrTxId, ownerId);
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
     * MODUL 1 & 3: Format Debtors / Suppliers list isolated by `ownerId`.
     * Supports calling as `(page, perPage, ownerId)` or `(ownerId, page, perPage)`.
     */
    static async getFormattedDebtorsReport(pageOrOwnerId = 1, perPageOrPage = 10, maybeOwnerId) {
        let page = 1;
        let perPage = 10;
        let ownerId = env_1.env.OWNER_TELEGRAM_ID;
        if (typeof pageOrOwnerId === 'string') {
            ownerId = pageOrOwnerId;
            page = typeof perPageOrPage === 'number' ? perPageOrPage : 1;
            perPage = typeof maybeOwnerId === 'number' ? maybeOwnerId : 10;
        }
        else {
            page = pageOrOwnerId || 1;
            perPage = perPageOrPage || 10;
            ownerId = typeof maybeOwnerId === 'string' && maybeOwnerId ? maybeOwnerId : env_1.env.OWNER_TELEGRAM_ID;
        }
        const cleanOwnerId = String(ownerId).trim();
        const [totalCount, aggregateResult] = await Promise.all([
            prisma_1.prisma.supplier.count({ where: { ownerId: cleanOwnerId, isActive: true } }),
            prisma_1.prisma.supplier.aggregate({
                where: { ownerId: cleanOwnerId, isActive: true },
                _sum: { debtUzs: true, debtUsd: true },
            }),
        ]);
        const totalPages = Math.ceil(totalCount / perPage) || 1;
        const currentPage = Math.max(1, Math.min(page, totalPages));
        const suppliers = await prisma_1.prisma.supplier.findMany({
            where: { ownerId: cleanOwnerId, isActive: true },
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
