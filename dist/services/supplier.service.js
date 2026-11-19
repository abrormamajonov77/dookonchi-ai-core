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
const transliterate_1 = require("../utils/transliterate");
const fuzzy_1 = require("../utils/fuzzy");
const formatters_1 = require("../utils/formatters");
const ai_service_1 = require("./ai.service");
const image_service_1 = require("./image.service");
class SupplierService {
    static computeImageHash(buffer) {
        return image_service_1.ImageService.getImageHash(buffer);
    }
    static computeContentFingerprint(params) {
        const ownerPrefix = params.ownerId ? `${String(params.ownerId).trim()}|` : '';
        const normSupp = this.normalizeName(params.supplierName || "noma'lum");
        const items = params.items || params.rows || [];
        const first3 = items
            .slice(0, 3)
            .map((it) => {
            if (typeof it === 'string') {
                return (0, transliterate_1.normalizeForSearch)(it);
            }
            const n = (0, transliterate_1.normalizeForSearch)(it.normalizedName || it.rawName || it.productName || '');
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
        const supName = (0, transliterate_1.toLatinUz)(existingInvoice.supplier?.name || "Noma'lum");
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
        return (0, transliterate_1.toLatinUz)(name)
            .toLowerCase()
            .trim()
            .replace(/(dan yuk keldi|yuk keldi)$/i, '')
            .replace(/\s+(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|akadan|okadan)(dan|ga|ni|ning)?$/i, '')
            .replace(/(akadan|okadan|aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla|jon|bek|dan|ga|ni|ning)$/i, '')
            .trim();
    }
    /**
     * MODUL 4: Fuzzy Supplier Typo Guard ("Dinar" vs "Diner" / "Dinar kalbasa").
     * 1) Checks exact match (case-insensitive & Latin-normalized).
     * 2) Checks fuzzy similarity (Levenshtein distance <= 2 or similarity >= 70% or first-word match).
     * 3) Suggests existing supplier before creating a duplicate/typo supplier profile!
     */
    static async findOrSuggestSupplier(rawInputName, ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const inputName = this.cleanSupplierName((0, transliterate_1.toLatinUz)(rawInputName || ''));
        const inputNorm = (0, transliterate_1.normalizeForSearch)(inputName);
        if (!inputNorm || inputNorm.length < 2) {
            return {
                status: 'NEW_SUPPLIER',
                isExactMatch: false,
                isFuzzyMatch: false,
                inputName,
                supplier: null,
                suggestedSupplier: null,
                similarity: 0,
                distance: Infinity,
                promptText: null,
            };
        }
        const activeSuppliers = await cache_service_1.cacheService.getSuppliersList(cleanOwnerId);
        // Step 1: Exact match check
        for (const s of activeSuppliers) {
            const sLatin = (0, transliterate_1.toLatinUz)(s.name).trim();
            const sNorm = (0, transliterate_1.normalizeForSearch)(sLatin);
            if (sLatin.toLowerCase() === inputName.toLowerCase() || sNorm === inputNorm) {
                return {
                    status: 'EXACT_MATCH',
                    isExactMatch: true,
                    isFuzzyMatch: false,
                    inputName: s.name,
                    supplier: s,
                    suggestedSupplier: null,
                    similarity: 1,
                    distance: 0,
                    promptText: null,
                };
            }
        }
        // Step 2: Fuzzy / Levenshtein / First-Word similarity check
        const inFirstWord = inputNorm.split(/\s+/)[0];
        let bestSupplier = null;
        let bestScore = 0;
        let bestDist = Infinity;
        for (const s of activeSuppliers) {
            const sLatin = (0, transliterate_1.toLatinUz)(s.name).trim();
            const sNorm = (0, transliterate_1.normalizeForSearch)(sLatin);
            if (!sNorm)
                continue;
            const sFirstWord = sNorm.split(/\s+/)[0];
            const fullDist = (0, fuzzy_1.levenshteinDistance)(inputNorm, sNorm);
            const fullSim = (0, fuzzy_1.calculateSimilarity)(inputNorm, sNorm);
            const firstWordDist = (0, fuzzy_1.levenshteinDistance)(inFirstWord, sFirstWord);
            const firstWordSim = (0, fuzzy_1.calculateSimilarity)(inFirstWord, sFirstWord);
            const isCloseFull = (inputNorm.length >= 4 && fullDist <= 2) ||
                (inputNorm.length === 3 && fullDist <= 1) ||
                fullSim >= 0.7;
            const isCloseFirstWord = inFirstWord.length >= 3 &&
                sFirstWord.length >= 3 &&
                (firstWordDist <= 2 || firstWordSim >= 0.7 || sFirstWord === inFirstWord);
            const isSubstringMatch = inputNorm.length >= 3 && (sNorm.startsWith(inputNorm) || inputNorm.startsWith(sFirstWord));
            if (isCloseFull || isCloseFirstWord || isSubstringMatch) {
                const effectiveSim = Math.max(fullSim, firstWordSim, isSubstringMatch ? 0.85 : 0);
                const effectiveDist = Math.min(fullDist, firstWordDist);
                if (effectiveSim > bestScore || (effectiveSim === bestScore && effectiveDist < bestDist)) {
                    bestScore = effectiveSim;
                    bestDist = effectiveDist;
                    bestSupplier = s;
                }
            }
        }
        if (bestSupplier) {
            const uzsText = (0, formatters_1.formatCurrency)(bestSupplier.debtUzs, 'UZS');
            const usdVal = Number(bestSupplier.debtUsd || 0);
            const debtDisplay = usdVal > 0 ? `${uzsText} | ${(0, formatters_1.formatCurrency)(usdVal, 'USD')}` : uzsText;
            const promptText = `🤔 Bazada '${inputName}' topilmadi, lekin juda o'xshash ta'minotchi bor:\n\n` +
                `🏢 ${bestSupplier.name} (Joriy qarz: ${debtDisplay})\n\n` +
                `Shu ta'minotchiga qo'shamizmi yoki yangi sahifa ochamizmi?`;
            return {
                status: 'FUZZY_MATCH',
                isExactMatch: false,
                isFuzzyMatch: true,
                inputName,
                supplier: null,
                suggestedSupplier: bestSupplier,
                similarity: bestScore,
                distance: bestDist,
                promptText,
            };
        }
        return {
            status: 'NEW_SUPPLIER',
            isExactMatch: false,
            isFuzzyMatch: false,
            inputName,
            supplier: null,
            suggestedSupplier: null,
            similarity: 0,
            distance: Infinity,
            promptText: null,
        };
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
        const exactMatch = suppliers.find((s) => this.normalizeName(s.name) === cleanName ||
            (0, transliterate_1.toLatinUz)(s.name).trim().toLowerCase() === (0, transliterate_1.toLatinUz)(rawName).trim().toLowerCase());
        if (exactMatch)
            return [exactMatch];
        if (!contextComment)
            return suppliers;
        const commentLower = (0, transliterate_1.toLatinUz)(contextComment).toLowerCase();
        const exact = suppliers.find((s) => (0, transliterate_1.toLatinUz)(s.name)
            .toLowerCase()
            .replace(cleanName, '')
            .trim()
            .split(/\s+/)
            .some((w) => w.length > 2 && commentLower.includes(w)));
        return exact ? [exact] : suppliers;
    }
    static cleanSupplierName(name) {
        return (0, transliterate_1.toLatinUz)(name || '')
            .trim()
            .replace(/(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla)$/gi, '')
            .trim();
    }
    static async getOrMergeSupplier(tx, rawName, exactSupplierId, ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const latinRawName = (0, transliterate_1.toLatinUz)(rawName).trim();
        if (exactSupplierId && exactSupplierId !== 'CREATE_NEW') {
            const s = await tx.supplier.findFirst({ where: { id: exactSupplierId, ownerId: cleanOwnerId } });
            if (s)
                return s;
        }
        const normalizedName = this.cleanSupplierName(latinRawName);
        const existing = await tx.supplier.findMany({
            where: {
                ownerId: cleanOwnerId,
                isActive: true,
                OR: [
                    { name: { equals: normalizedName, mode: 'insensitive' } },
                    { name: { equals: latinRawName, mode: 'insensitive' } },
                    { name: { contains: normalizedName, mode: 'insensitive' } },
                ],
            },
            orderBy: { debtUzs: 'desc' },
        });
        if (!existing.length) {
            return tx.supplier.upsert({
                where: { ownerId_name: { ownerId: cleanOwnerId, name: latinRawName } },
                create: { ownerId: cleanOwnerId, name: latinRawName, debtUzs: 0, debtUsd: 0, isActive: true },
                update: { isActive: true },
            });
        }
        const primary = existing[0];
        for (const dup of existing.slice(1)) {
            await tx.invoice.updateMany({
                where: { ownerId: cleanOwnerId, supplierId: dup.id },
                data: { supplierId: primary.id },
            });
            await tx.invoiceItem
                .updateMany({ where: { ownerId: cleanOwnerId, supplierId: dup.id }, data: { supplierId: primary.id } })
                .catch(() => { });
            await tx.supplierTransaction.updateMany({
                where: { ownerId: cleanOwnerId, supplierId: dup.id },
                data: { supplierId: primary.id },
            });
            await tx.supplierPayment
                .updateMany({ where: { ownerId: cleanOwnerId, supplierId: dup.id }, data: { supplierId: primary.id } })
                .catch(() => { });
            await tx.supplier.update({
                where: { id: primary.id },
                data: { debtUzs: { increment: dup.debtUzs }, debtUsd: { increment: dup.debtUsd } },
            });
            await tx.supplier.delete({ where: { id: dup.id } });
        }
        return existing.length > 1
            ? (await tx.supplier.findFirst({ where: { id: primary.id, ownerId: cleanOwnerId } })) || primary
            : primary;
    }
    static async checkOrRenameSupplier(supplierId, rawNewName, ownerId) {
        const newName = (0, transliterate_1.toLatinUz)(rawNewName).trim();
        if (!newName || newName.length < 2) {
            throw new Error("Ta'minotchi nomi kamida 2 ta harfdan iborat bo'lishi kerak.");
        }
        const cleanOwnerId = ownerId ? String(ownerId).trim() : undefined;
        const sourceSupplier = cleanOwnerId
            ? await prisma_1.prisma.supplier.findFirst({ where: { id: supplierId, ownerId: cleanOwnerId } })
            : await prisma_1.prisma.supplier.findUnique({ where: { id: supplierId } });
        if (!sourceSupplier) {
            throw new Error("Ta'minotchi topilmadi yoki ruxsat yo'q.");
        }
        const effectiveOwnerId = String(cleanOwnerId || sourceSupplier.ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
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
        const cleanOwnerId = ownerId ? String(ownerId).trim() : undefined;
        if (sourceSupplierId === targetSupplierId) {
            const same = cleanOwnerId
                ? await prisma_1.prisma.supplier.findFirst({ where: { id: targetSupplierId, ownerId: cleanOwnerId } })
                : await prisma_1.prisma.supplier.findUnique({ where: { id: targetSupplierId } });
            if (!same)
                throw new Error("Ta'minotchi topilmadi yoki ruxsat yo'q.");
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
            if (cleanOwnerId && (source.ownerId !== cleanOwnerId || target.ownerId !== cleanOwnerId)) {
                throw new Error("Boshqa foydalanuvchi ta'minotchisini birlashtirish mumkin emas.");
            }
            if (source.ownerId !== target.ownerId) {
                throw new Error("Boshqa foydalanuvchi ta'minotchisini birlashtirish mumkin emas.");
            }
            const scopedOwnerId = source.ownerId;
            await Promise.all([
                tx.invoice.updateMany({
                    where: { ownerId: scopedOwnerId, supplierId: source.id },
                    data: { supplierId: target.id },
                }),
                tx.invoiceItem.updateMany({
                    where: { ownerId: scopedOwnerId, supplierId: source.id },
                    data: { supplierId: target.id },
                }),
                tx.supplierTransaction.updateMany({
                    where: { ownerId: scopedOwnerId, supplierId: source.id },
                    data: { supplierId: target.id },
                }),
                tx.supplierPayment.updateMany({
                    where: { ownerId: scopedOwnerId, supplierId: source.id },
                    data: { supplierId: target.id },
                }),
            ]);
            const [updatedTarget] = await Promise.all([
                tx.supplier.update({
                    where: { id: target.id },
                    data: {
                        name: (0, transliterate_1.toLatinUz)(target.name),
                        debtUzs: { increment: source.debtUzs },
                        debtUsd: { increment: source.debtUsd },
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
        const originalFileId = params.imageFileId || params.photoFileId || null;
        const currency = params.currency || 'UZS';
        const paymentSource = params.paymentSource || 'TODAY_CASH';
        const createdAt = params.createdAt || new Date();
        const latinSupplierName = (0, transliterate_1.toLatinUz)(params.supplierName || "Noma'lum").trim();
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
                supplierName: latinSupplierName,
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
        const verbatimText = (0, transliterate_1.toLatinUz)(params.verbatimText ||
            (normalizedItems.length > 0 ? (0, ai_service_1.buildVerbatimTableText)(normalizedItems, currency) : ''));
        return prisma_1.prisma.$transaction(async (tx) => {
            let supplier = params.supplierId
                ? await tx.supplier.findFirst({ where: { id: params.supplierId, ownerId } })
                : null;
            if (!supplier) {
                const found = await tx.supplier.findFirst({
                    where: { ownerId, name: { equals: latinSupplierName, mode: 'insensitive' } },
                });
                if (found) {
                    supplier = await tx.supplier.update({
                        where: { id: found.id },
                        data: currency === 'USD'
                            ? {
                                name: (0, transliterate_1.toLatinUz)(found.name),
                                ...(creditAmount !== 0 ? { debtUsd: { increment: creditAmount } } : {}),
                                isActive: true,
                            }
                            : {
                                name: (0, transliterate_1.toLatinUz)(found.name),
                                ...(creditAmount !== 0 ? { debtUzs: { increment: creditAmount } } : {}),
                                isActive: true,
                            },
                    });
                }
                else {
                    supplier = await tx.supplier.upsert({
                        where: { ownerId_name: { ownerId, name: latinSupplierName } },
                        create: {
                            ownerId,
                            name: latinSupplierName,
                            debtUzs: currency === 'UZS' ? creditAmount : 0,
                            debtUsd: currency === 'USD' ? creditAmount : 0,
                            isActive: true,
                        },
                        update: currency === 'USD'
                            ? {
                                ...(creditAmount !== 0 ? { debtUsd: { increment: creditAmount } } : {}),
                                isActive: true,
                            }
                            : {
                                ...(creditAmount !== 0 ? { debtUzs: { increment: creditAmount } } : {}),
                                isActive: true,
                            },
                    });
                }
            }
            else {
                supplier = await tx.supplier.update({
                    where: { id: supplier.id },
                    data: currency === 'USD'
                        ? {
                            name: (0, transliterate_1.toLatinUz)(supplier.name),
                            ...(creditAmount !== 0 ? { debtUsd: { increment: creditAmount } } : {}),
                            isActive: true,
                        }
                        : {
                            name: (0, transliterate_1.toLatinUz)(supplier.name),
                            ...(creditAmount !== 0 ? { debtUzs: { increment: creditAmount } } : {}),
                            isActive: true,
                        },
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
                    paymentSource,
                    paidCashAmount,
                    creditAmount,
                    imageHash,
                    contentFingerprint,
                    verbatimText: verbatimText || null,
                    imageFileId: originalFileId,
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
                        paymentSource,
                        items: JSON.stringify(normalizedItems),
                        createdBy: ownerId,
                        createdAt,
                    },
                });
            }
            if (normalizedItems.length > 0) {
                const existingProducts = await tx.product.findMany({
                    where: { ownerId },
                    select: { id: true, name: true, searchTokens: true },
                });
                const invoiceItemsData = [];
                for (const item of normalizedItems) {
                    const itemName = (0, transliterate_1.toLatinUz)(item.rawName || item.productName).trim();
                    const normName = (0, transliterate_1.normalizeForSearch)(itemName) || itemName.toLowerCase();
                    const searchTokens = translit_service_1.TranslitService.generateSearchTokens(itemName);
                    const itemCurrency = item.currency || currency;
                    const lowerItemName = itemName.toLowerCase();
                    const foundProd = existingProducts.find((p) => p.name.toLowerCase() === lowerItemName) ||
                        existingProducts.find((p) => p.searchTokens.toLowerCase().includes(normName));
                    let productId;
                    if (foundProd) {
                        await tx.product.update({
                            where: { id: foundProd.id },
                            data: {
                                name: itemName,
                                searchTokens,
                                lastPrice: item.unitPrice,
                                currency: itemCurrency,
                                updatedAt: createdAt,
                            },
                            select: { id: true },
                        });
                        foundProd.name = itemName;
                        foundProd.searchTokens = searchTokens;
                        productId = foundProd.id;
                    }
                    else {
                        const createdProd = await tx.product.create({
                            data: {
                                ownerId,
                                name: itemName,
                                searchTokens,
                                lastPrice: item.unitPrice,
                                currency: itemCurrency,
                                createdAt,
                                updatedAt: createdAt,
                            },
                            select: { id: true, name: true, searchTokens: true },
                        });
                        existingProducts.push(createdProd);
                        productId = createdProd.id;
                    }
                    invoiceItemsData.push({
                        ownerId,
                        invoiceId: invoice.id,
                        supplierId: supplier.id,
                        productId,
                        rawName: itemName,
                        normalizedName: normName,
                        quantity: item.quantity,
                        unit: (0, transliterate_1.toLatinUz)(item.unit || 'dona'),
                        unitPrice: item.unitPrice,
                        totalPrice: item.lineTotal,
                        lineTotal: item.lineTotal,
                        currency: itemCurrency,
                        createdAt,
                    });
                }
                if (invoiceItemsData.length > 0) {
                    await tx.invoiceItem.createMany({ data: invoiceItemsData });
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
                    paymentSource,
                    amount: math.finalTotal,
                    originalAmount: math.rawTotal,
                    discountAmount: math.discountAmount,
                    currency,
                    date: createdAt,
                    photoFileId: originalFileId,
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
                        paymentSource,
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
    /**
     * MODUL 5: Record supplier payment with explicit `paymentSource` ("TODAY_CASH" vs "PREVIOUS_SAFE").
     * Uses atomic DB decrement so concurrent payments never lose updates.
     */
    static async recordSupplierPayment(params) {
        const ownerId = String(params.ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const currency = params.currency || 'UZS';
        const paymentSource = params.paymentSource || 'TODAY_CASH';
        const isUsd = currency === 'USD';
        const amount = Math.max(0, Number(Math.abs(params.amount || 0).toFixed(2)));
        const createdAt = params.createdAt || new Date();
        const sourceLabel = paymentSource === 'PREVIOUS_SAFE' ? "Kechagi puldan / Seyfdan to'lov" : "Bugungi kassadan to'lov";
        const commentText = (0, transliterate_1.toLatinUz)(params.comment || params.note || sourceLabel);
        return prisma_1.prisma.$transaction(async (tx) => {
            const supplier = await this.getOrMergeSupplier(tx, (0, transliterate_1.toLatinUz)(params.supplierName), params.supplierId, ownerId);
            const [payment, transaction, updatedSupplier] = await Promise.all([
                tx.supplierPayment.create({
                    data: {
                        ownerId,
                        supplierId: supplier.id,
                        amount,
                        currency,
                        paymentSource,
                        comment: commentText,
                        createdAt,
                    },
                }),
                tx.supplierTransaction.create({
                    data: {
                        ownerId,
                        supplierId: supplier.id,
                        type: 'PAYMENT',
                        paymentSource,
                        amount,
                        currency,
                        date: createdAt,
                        sourceType: 'MANUAL',
                        description: commentText,
                    },
                }),
                tx.supplier.update({
                    where: { id: supplier.id },
                    data: isUsd ? { debtUsd: { decrement: amount } } : { debtUzs: { decrement: amount } },
                }),
            ]);
            cache_service_1.cacheService.invalidateSupplierNames(ownerId);
            return { supplier: updatedSupplier, payment, transaction };
        }, { maxWait: 15000, timeout: 30000 });
    }
    static buildFormattedReceiptText(params) {
        const cur = params.currency;
        const body = params.verbatimText ? `${(0, transliterate_1.toLatinUz)(params.verbatimText)}\n` : '';
        let text = `🧾 ELEKTRON NAKLADNOY\n` +
            `🏢 Ta'minotchi: ${(0, transliterate_1.toLatinUz)(params.supplierName)}\n` +
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
        const cleanOwnerId = ownerId ? String(ownerId).trim() : undefined;
        let invoice = await tx.invoice.findUnique({
            where: { id: idOrTxId },
            include: { supplier: true },
        });
        if (invoice && cleanOwnerId && invoice.ownerId !== cleanOwnerId) {
            throw new Error("Ruxsat yo'q.");
        }
        let supTx = invoice
            ? await tx.supplierTransaction.findFirst({
                where: {
                    ownerId: invoice.ownerId,
                    OR: [{ invoiceId: invoice.id }, { supplierId: invoice.supplierId, type: 'INCOMING_GOODS' }],
                },
                orderBy: { date: 'desc' },
            })
            : null;
        if (!invoice) {
            supTx = await tx.supplierTransaction.findUnique({ where: { id: idOrTxId } });
            if (supTx && cleanOwnerId && supTx.ownerId !== cleanOwnerId) {
                throw new Error("Ruxsat yo'q.");
            }
            const linkedInvoiceId = supTx?.invoiceId || supTx?.receiptData?.invoiceId;
            if (linkedInvoiceId) {
                invoice = await tx.invoice.findUnique({
                    where: { id: String(linkedInvoiceId) },
                    include: { supplier: true },
                });
                if (invoice && cleanOwnerId && invoice.ownerId !== cleanOwnerId) {
                    throw new Error("Ruxsat yo'q.");
                }
            }
        }
        if (!invoice) {
            throw new Error("Ushbu amaliyotga bog'langan nakladnoy topilmadi.");
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
                        ? { debtUsd: { increment: delta } }
                        : { debtUzs: { increment: delta } },
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
            cache_service_1.cacheService.invalidateSupplierNames(updatedSupplier.ownerId);
            return {
                invoice: updatedInvoice,
                supplier: updatedSupplier,
                rawTotal: math.rawTotal,
                discountAmount: math.discountAmount,
                finalTotal: math.finalTotal,
                currency,
                photoFileId: updatedInvoice.imageFileId || supTx?.photoFileId || null,
                supTxId: supTx?.id || updatedInvoice.id,
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
                        ? { debtUsd: { increment: delta } }
                        : { debtUzs: { increment: delta } },
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
            cache_service_1.cacheService.invalidateSupplierNames(updatedSupplier.ownerId);
            return {
                invoice: updatedInvoice,
                supplier: updatedSupplier,
                rawTotal,
                discountAmount,
                finalTotal,
                currency,
                photoFileId: updatedInvoice.imageFileId || supTx?.photoFileId || null,
                supTxId: supTx?.id || updatedInvoice.id,
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
            const [updatedSupplier, updatedInvoice] = await Promise.all([
                tx.supplier.update({
                    where: { id: invoice.supplierId },
                    data: oldCurrency === 'UZS'
                        ? { debtUzs: { decrement: finalTotal }, debtUsd: { increment: finalTotal } }
                        : { debtUzs: { increment: finalTotal }, debtUsd: { decrement: finalTotal } },
                }),
                tx.invoice.update({
                    where: { id: invoice.id },
                    data: { currency: newCurrency },
                }),
                tx.invoiceItem.updateMany({
                    where: { ownerId: invoice.ownerId, invoiceId: invoice.id },
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
            cache_service_1.cacheService.invalidateSupplierNames(updatedSupplier.ownerId);
            return {
                invoice: updatedInvoice,
                supplier: updatedSupplier,
                rawTotal,
                discountAmount,
                finalTotal,
                currency: newCurrency,
                photoFileId: updatedInvoice.imageFileId || supTx?.photoFileId || null,
                supTxId: supTx?.id || updatedInvoice.id,
            };
        }, { maxWait: 15000, timeout: 30000 });
    }
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
                .map((sup) => (0, formatters_1.formatSupplierDebtLine)((0, transliterate_1.toLatinUz)(sup.name), sup.debtUzs, sup.debtUsd, '🏢 '))
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
