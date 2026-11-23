"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSupplierFullHistory = exports.deleteSupplierRecord = exports.updateSupplierRecordAmount = exports.addSupplierReturn = exports.getSupplierRecordDetail = exports.getSupplierRecordsPaginated = exports.getSupplierBalance = exports.SupplierService = void 0;
exports.computeSupplierBalanceFromLedger = computeSupplierBalanceFromLedger;
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
function roundMoney(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num))
        return 0;
    const rounded = Number(num.toFixed(2));
    return Object.is(rounded, -0) ? 0 : rounded;
}
function toAuditTelegramId(ownerId) {
    const cleaned = String(ownerId || '').trim();
    if (/^\d+$/.test(cleaned)) {
        return BigInt(cleaned);
    }
    return BigInt(0);
}
function categoryToTransactionType(category) {
    if (category === 'CHEKLAR')
        return 'INCOMING_GOODS';
    if (category === 'PULLAR')
        return 'PAYMENT';
    return 'RETURN';
}
/**
 * Pure deterministic balance calculator across SupplierTransaction, Invoice, and SupplierPayment.
 * Avoids double-counting linked Invoice/SupplierPayment rows while properly honoring CASH/PARTIAL
 * invoices and RETURN transactions: Net Debt = Total Incoming Goods - Total Payments - Total Returns.
 */
function computeSupplierBalanceFromLedger(ownerId, supplierId, input) {
    const acc = {
        UZS: { incoming: 0, payments: 0, returns: 0 },
        USD: { incoming: 0, payments: 0, returns: 0 },
    };
    const invoices = input.invoices || [];
    const payments = input.payments || [];
    const invoiceById = new Map(invoices.map((inv) => [inv.id, inv]));
    const linkedInvoiceIds = new Set();
    const paymentTxMatches = [];
    for (const tx of input.transactions) {
        const cur = tx.currency === 'USD' ? 'USD' : 'UZS';
        const amt = Math.abs(Number(tx.amount || 0));
        if (tx.type === 'INCOMING_GOODS') {
            const invId = tx.invoiceId || tx.receiptData?.invoiceId || null;
            const linkedInv = invId ? invoiceById.get(String(invId)) : undefined;
            if (linkedInv) {
                linkedInvoiceIds.add(linkedInv.id);
                const invCur = linkedInv.currency === 'USD' ? 'USD' : 'UZS';
                const invTotal = Math.abs(Number(linkedInv.totalAmount || 0));
                const invPaidCash = linkedInv.paymentType === 'CASH'
                    ? invTotal
                    : linkedInv.paymentType === 'PARTIAL'
                        ? Math.min(invTotal, Math.abs(Number(linkedInv.paidCashAmount || 0)))
                        : 0;
                acc[invCur].incoming += invTotal;
                if (invPaidCash > 0) {
                    acc[invCur].payments += invPaidCash;
                }
            }
            else {
                const rd = tx.receiptData || {};
                acc[cur].incoming += amt;
                if (rd.paymentType === 'CASH') {
                    acc[cur].payments += amt;
                }
                else if (rd.paymentType === 'PARTIAL' && Number(rd.paidCashAmount || 0) > 0) {
                    acc[cur].payments += Math.min(amt, Math.abs(Number(rd.paidCashAmount || 0)));
                }
            }
        }
        else if (tx.type === 'PAYMENT') {
            acc[cur].payments += amt;
            paymentTxMatches.push({
                currency: cur,
                amount: roundMoney(amt),
                time: new Date(tx.date).getTime(),
                matched: false,
            });
        }
        else if (tx.type === 'RETURN') {
            acc[cur].returns += amt;
        }
    }
    // Include any orphan Invoice rows not linked to a SupplierTransaction
    for (const inv of invoices) {
        if (linkedInvoiceIds.has(inv.id))
            continue;
        const cur = inv.currency === 'USD' ? 'USD' : 'UZS';
        const invTotal = Math.abs(Number(inv.totalAmount || 0));
        const invPaidCash = inv.paymentType === 'CASH'
            ? invTotal
            : inv.paymentType === 'PARTIAL'
                ? Math.min(invTotal, Math.abs(Number(inv.paidCashAmount || 0)))
                : 0;
        acc[cur].incoming += invTotal;
        if (invPaidCash > 0) {
            acc[cur].payments += invPaidCash;
        }
    }
    // Include any orphan SupplierPayment rows not already represented in SupplierTransaction(PAYMENT)
    for (const p of payments) {
        const cur = p.currency === 'USD' ? 'USD' : 'UZS';
        const amt = roundMoney(Math.abs(Number(p.amount || 0)));
        const pTime = new Date(p.createdAt).getTime();
        const match = paymentTxMatches.find((m) => !m.matched && m.currency === cur && Math.abs(m.amount - amt) < 0.01 && Math.abs(m.time - pTime) <= 10_000);
        if (match) {
            match.matched = true;
        }
        else {
            acc[cur].payments += amt;
        }
    }
    const uzsIncoming = roundMoney(acc.UZS.incoming);
    const uzsPayments = roundMoney(acc.UZS.payments);
    const uzsReturns = roundMoney(acc.UZS.returns);
    const debtUzs = roundMoney(uzsIncoming - uzsPayments - uzsReturns);
    const usdIncoming = roundMoney(acc.USD.incoming);
    const usdPayments = roundMoney(acc.USD.payments);
    const usdReturns = roundMoney(acc.USD.returns);
    const debtUsd = roundMoney(usdIncoming - usdPayments - usdReturns);
    return {
        supplierId,
        ownerId,
        uzs: {
            totalIncoming: uzsIncoming,
            totalPayments: uzsPayments,
            totalReturns: uzsReturns,
            netDebt: debtUzs,
        },
        usd: {
            totalIncoming: usdIncoming,
            totalPayments: usdPayments,
            totalReturns: usdReturns,
            netDebt: debtUsd,
        },
        debtUzs,
        debtUsd,
    };
}
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
    static async computeAndSyncSupplierBalanceTx(tx, ownerId, supplierId) {
        const [transactions, invoices, payments] = await Promise.all([
            tx.supplierTransaction.findMany({
                where: { ownerId, supplierId },
                orderBy: { date: 'asc' },
                select: {
                    id: true,
                    type: true,
                    amount: true,
                    currency: true,
                    date: true,
                    invoiceId: true,
                    receiptData: true,
                },
            }),
            tx.invoice.findMany({
                where: { ownerId, supplierId },
                orderBy: { createdAt: 'asc' },
                select: {
                    id: true,
                    totalAmount: true,
                    paidCashAmount: true,
                    creditAmount: true,
                    paymentType: true,
                    currency: true,
                    createdAt: true,
                },
            }),
            tx.supplierPayment.findMany({
                where: { ownerId, supplierId },
                orderBy: { createdAt: 'asc' },
                select: {
                    id: true,
                    amount: true,
                    currency: true,
                    createdAt: true,
                },
            }),
        ]);
        const balance = computeSupplierBalanceFromLedger(ownerId, supplierId, {
            transactions,
            invoices,
            payments,
        });
        const supplier = await tx.supplier.update({
            where: { id: supplierId },
            data: {
                debtUzs: balance.debtUzs,
                debtUsd: balance.debtUsd,
            },
        });
        return { balance, supplier };
    }
    /**
     * 1. Calculates exact net debt separately for UZS and USD from all records:
     * Total Incoming Goods - Total Payments - Total Returns (strictly ownerId scoped).
     */
    static async getSupplierBalance(ownerId, supplierId) {
        const cleanOwnerId = String(ownerId).trim();
        const cleanSupplierId = String(supplierId).trim();
        const supplier = await prisma_1.prisma.supplier.findFirst({
            where: { id: cleanSupplierId, ownerId: cleanOwnerId },
            select: { id: true },
        });
        if (!supplier) {
            throw new Error("Ta'minotchi topilmadi yoki ruxsat yo'q.");
        }
        const [transactions, invoices, payments] = await Promise.all([
            prisma_1.prisma.supplierTransaction.findMany({
                where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                orderBy: { date: 'asc' },
                select: {
                    id: true,
                    type: true,
                    amount: true,
                    currency: true,
                    date: true,
                    invoiceId: true,
                    receiptData: true,
                },
            }),
            prisma_1.prisma.invoice.findMany({
                where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                orderBy: { createdAt: 'asc' },
                select: {
                    id: true,
                    totalAmount: true,
                    paidCashAmount: true,
                    creditAmount: true,
                    paymentType: true,
                    currency: true,
                    createdAt: true,
                },
            }),
            prisma_1.prisma.supplierPayment.findMany({
                where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                orderBy: { createdAt: 'asc' },
                select: {
                    id: true,
                    amount: true,
                    currency: true,
                    createdAt: true,
                },
            }),
        ]);
        return computeSupplierBalanceFromLedger(cleanOwnerId, cleanSupplierId, {
            transactions,
            invoices,
            payments,
        });
    }
    /**
     * 2. Paginated supplier records by category: 'CHEKLAR' | 'PULLAR' | 'VOZVRAT'.
     * Strictly filtered by ownerId and ordered newest first.
     */
    static async getSupplierRecordsPaginated(ownerId, supplierId, category, page = 1, limit = 5) {
        const cleanOwnerId = String(ownerId).trim();
        const cleanSupplierId = String(supplierId).trim();
        const safeLimit = Math.max(1, Math.min(50, Math.floor(limit || 5)));
        const supplier = await prisma_1.prisma.supplier.findFirst({
            where: { id: cleanSupplierId, ownerId: cleanOwnerId },
            select: { id: true, name: true },
        });
        if (!supplier) {
            throw new Error("Ta'minotchi topilmadi yoki ruxsat yo'q.");
        }
        const supplierName = (0, transliterate_1.toLatinUz)(supplier.name);
        const records = [];
        if (category === 'CHEKLAR') {
            const [txs, invoices] = await Promise.all([
                prisma_1.prisma.supplierTransaction.findMany({
                    where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId, type: 'INCOMING_GOODS' },
                    orderBy: { date: 'desc' },
                }),
                prisma_1.prisma.invoice.findMany({
                    where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                    orderBy: { createdAt: 'desc' },
                    include: {
                        items: {
                            select: {
                                rawName: true,
                                quantity: true,
                                unit: true,
                                unitPrice: true,
                                totalPrice: true,
                                currency: true,
                            },
                        },
                    },
                }),
            ]);
            const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
            const linkedInvoiceIds = new Set();
            for (const tx of txs) {
                const invId = tx.invoiceId || tx.receiptData?.invoiceId || null;
                const inv = invId ? invoiceMap.get(String(invId)) : undefined;
                if (inv)
                    linkedInvoiceIds.add(inv.id);
                const note = (0, transliterate_1.toLatinUz)(tx.description ||
                    (inv?.invoiceNo ? `Nakladnoy #${inv.invoiceNo}` : 'Yuk keldi')).trim();
                records.push({
                    id: tx.id,
                    supplierId: cleanSupplierId,
                    supplierName,
                    category: 'CHEKLAR',
                    type: 'INCOMING_GOODS',
                    amount: roundMoney(Number(inv ? inv.totalAmount : tx.amount)),
                    currency: (inv?.currency || tx.currency),
                    date: tx.date,
                    createdAt: tx.date,
                    note,
                    paymentType: inv?.paymentType || tx.receiptData?.paymentType || 'CREDIT',
                    paymentSource: inv?.paymentSource || tx.paymentSource,
                    invoiceId: inv?.id || tx.invoiceId || null,
                    invoiceNo: inv?.invoiceNo || tx.receiptData?.invoiceNo || null,
                    originalAmount: inv?.originalAmount != null
                        ? roundMoney(Number(inv.originalAmount))
                        : tx.originalAmount != null
                            ? roundMoney(Number(tx.originalAmount))
                            : null,
                    discountAmount: inv?.discountAmount != null
                        ? roundMoney(Number(inv.discountAmount))
                        : tx.discountAmount != null
                            ? roundMoney(Number(tx.discountAmount))
                            : null,
                    photoFileId: inv?.imageFileId || tx.photoFileId || null,
                    verbatimText: inv?.verbatimText || tx.formattedReceipt || null,
                    items: inv?.items?.map((it) => ({
                        rawName: (0, transliterate_1.toLatinUz)(it.rawName || "Noma'lum"),
                        quantity: Number(it.quantity),
                        unit: (0, transliterate_1.toLatinUz)(it.unit || 'dona'),
                        unitPrice: roundMoney(Number(it.unitPrice)),
                        totalPrice: roundMoney(Number(it.totalPrice)),
                        currency: it.currency,
                    })),
                });
            }
            for (const inv of invoices) {
                if (linkedInvoiceIds.has(inv.id))
                    continue;
                records.push({
                    id: inv.id,
                    supplierId: cleanSupplierId,
                    supplierName,
                    category: 'CHEKLAR',
                    type: 'INCOMING_GOODS',
                    amount: roundMoney(Number(inv.totalAmount)),
                    currency: inv.currency,
                    date: inv.createdAt,
                    createdAt: inv.createdAt,
                    note: (0, transliterate_1.toLatinUz)(inv.invoiceNo ? `Nakladnoy #${inv.invoiceNo}` : 'Nakladnoy'),
                    paymentType: inv.paymentType,
                    paymentSource: inv.paymentSource,
                    invoiceId: inv.id,
                    invoiceNo: inv.invoiceNo,
                    originalAmount: inv.originalAmount != null ? roundMoney(Number(inv.originalAmount)) : null,
                    discountAmount: inv.discountAmount != null ? roundMoney(Number(inv.discountAmount)) : null,
                    photoFileId: inv.imageFileId,
                    verbatimText: inv.verbatimText,
                    items: inv.items.map((it) => ({
                        rawName: (0, transliterate_1.toLatinUz)(it.rawName || "Noma'lum"),
                        quantity: Number(it.quantity),
                        unit: (0, transliterate_1.toLatinUz)(it.unit || 'dona'),
                        unitPrice: roundMoney(Number(it.unitPrice)),
                        totalPrice: roundMoney(Number(it.totalPrice)),
                        currency: it.currency,
                    })),
                });
            }
        }
        else if (category === 'PULLAR') {
            const [txs, payments] = await Promise.all([
                prisma_1.prisma.supplierTransaction.findMany({
                    where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId, type: 'PAYMENT' },
                    orderBy: { date: 'desc' },
                }),
                prisma_1.prisma.supplierPayment.findMany({
                    where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                    orderBy: { createdAt: 'desc' },
                }),
            ]);
            const txMarkers = txs.map((tx) => ({
                currency: tx.currency,
                amount: roundMoney(Number(tx.amount)),
                time: tx.date.getTime(),
                matched: false,
            }));
            for (const tx of txs) {
                records.push({
                    id: tx.id,
                    supplierId: cleanSupplierId,
                    supplierName,
                    category: 'PULLAR',
                    type: 'PAYMENT',
                    amount: roundMoney(Number(tx.amount)),
                    currency: tx.currency,
                    date: tx.date,
                    createdAt: tx.date,
                    note: (0, transliterate_1.toLatinUz)(tx.description ||
                        (tx.paymentSource === 'PREVIOUS_SAFE'
                            ? "Kechagi puldan / Seyfdan to'lov"
                            : "Bugungi kassadan to'lov")),
                    paymentSource: tx.paymentSource,
                });
            }
            for (const p of payments) {
                const pAmt = roundMoney(Number(p.amount));
                const pTime = p.createdAt.getTime();
                const match = txMarkers.find((m) => !m.matched &&
                    m.currency === p.currency &&
                    Math.abs(m.amount - pAmt) < 0.01 &&
                    Math.abs(m.time - pTime) <= 10_000);
                if (match) {
                    match.matched = true;
                    continue;
                }
                records.push({
                    id: p.id,
                    supplierId: cleanSupplierId,
                    supplierName,
                    category: 'PULLAR',
                    type: 'PAYMENT',
                    amount: pAmt,
                    currency: p.currency,
                    date: p.createdAt,
                    createdAt: p.createdAt,
                    note: (0, transliterate_1.toLatinUz)(p.comment || "To'lov"),
                    paymentSource: p.paymentSource,
                });
            }
        }
        else {
            const txs = await prisma_1.prisma.supplierTransaction.findMany({
                where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId, type: 'RETURN' },
                orderBy: { date: 'desc' },
            });
            for (const tx of txs) {
                records.push({
                    id: tx.id,
                    supplierId: cleanSupplierId,
                    supplierName,
                    category: 'VOZVRAT',
                    type: 'RETURN',
                    amount: roundMoney(Number(tx.amount)),
                    currency: tx.currency,
                    date: tx.date,
                    createdAt: tx.date,
                    note: (0, transliterate_1.toLatinUz)(tx.description || 'Vozvrat (Tovar qaytarildi)'),
                    paymentSource: tx.paymentSource,
                });
            }
        }
        records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const total = records.length;
        const totalPages = Math.max(1, Math.ceil(total / safeLimit));
        const currentPage = Math.max(1, Math.min(Math.floor(page || 1), totalPages));
        const start = (currentPage - 1) * safeLimit;
        const items = records.slice(start, start + safeLimit);
        return {
            items,
            total,
            page: currentPage,
            totalPages,
        };
    }
    /**
     * Fetch a single supplier record by category & recordId, strictly verified against ownerId.
     */
    static async getSupplierRecordDetail(ownerId, recordType, recordId) {
        const cleanOwnerId = String(ownerId).trim();
        const cleanRecordId = String(recordId).trim();
        const expectedType = categoryToTransactionType(recordType);
        const tx = await prisma_1.prisma.supplierTransaction.findFirst({
            where: { id: cleanRecordId, ownerId: cleanOwnerId, type: expectedType },
            include: { supplier: { select: { id: true, name: true } } },
        });
        if (tx) {
            let inv = null;
            if (recordType === 'CHEKLAR') {
                const linkedInvoiceId = tx.invoiceId || tx.receiptData?.invoiceId || null;
                if (linkedInvoiceId) {
                    inv = await prisma_1.prisma.invoice.findFirst({
                        where: { id: String(linkedInvoiceId), ownerId: cleanOwnerId },
                        include: {
                            items: {
                                select: {
                                    rawName: true,
                                    quantity: true,
                                    unit: true,
                                    unitPrice: true,
                                    totalPrice: true,
                                    currency: true,
                                },
                            },
                        },
                    });
                }
            }
            return {
                id: tx.id,
                supplierId: tx.supplierId,
                supplierName: (0, transliterate_1.toLatinUz)(tx.supplier.name),
                category: recordType,
                type: tx.type,
                amount: roundMoney(Number(inv ? inv.totalAmount : tx.amount)),
                currency: (inv?.currency || tx.currency),
                date: tx.date,
                createdAt: tx.date,
                note: (0, transliterate_1.toLatinUz)(tx.description ||
                    (recordType === 'VOZVRAT'
                        ? 'Vozvrat (Tovar qaytarildi)'
                        : recordType === 'PULLAR'
                            ? "To'lov"
                            : 'Yuk keldi')),
                paymentType: inv?.paymentType || tx.receiptData?.paymentType || null,
                paymentSource: inv?.paymentSource || tx.paymentSource,
                invoiceId: inv?.id || tx.invoiceId || null,
                invoiceNo: inv?.invoiceNo || tx.receiptData?.invoiceNo || null,
                originalAmount: inv?.originalAmount != null
                    ? roundMoney(Number(inv.originalAmount))
                    : tx.originalAmount != null
                        ? roundMoney(Number(tx.originalAmount))
                        : null,
                discountAmount: inv?.discountAmount != null
                    ? roundMoney(Number(inv.discountAmount))
                    : tx.discountAmount != null
                        ? roundMoney(Number(tx.discountAmount))
                        : null,
                photoFileId: inv?.imageFileId || tx.photoFileId || null,
                verbatimText: inv?.verbatimText || tx.formattedReceipt || null,
                items: inv?.items?.map((it) => ({
                    rawName: (0, transliterate_1.toLatinUz)(it.rawName || "Noma'lum"),
                    quantity: Number(it.quantity),
                    unit: (0, transliterate_1.toLatinUz)(it.unit || 'dona'),
                    unitPrice: roundMoney(Number(it.unitPrice)),
                    totalPrice: roundMoney(Number(it.totalPrice)),
                    currency: it.currency,
                })),
            };
        }
        if (recordType === 'CHEKLAR') {
            const inv = await prisma_1.prisma.invoice.findFirst({
                where: { id: cleanRecordId, ownerId: cleanOwnerId },
                include: {
                    supplier: { select: { id: true, name: true } },
                    items: {
                        select: {
                            rawName: true,
                            quantity: true,
                            unit: true,
                            unitPrice: true,
                            totalPrice: true,
                            currency: true,
                        },
                    },
                },
            });
            if (!inv)
                return null;
            return {
                id: inv.id,
                supplierId: inv.supplierId,
                supplierName: (0, transliterate_1.toLatinUz)(inv.supplier.name),
                category: 'CHEKLAR',
                type: 'INCOMING_GOODS',
                amount: roundMoney(Number(inv.totalAmount)),
                currency: inv.currency,
                date: inv.createdAt,
                createdAt: inv.createdAt,
                note: (0, transliterate_1.toLatinUz)(inv.invoiceNo ? `Nakladnoy #${inv.invoiceNo}` : 'Nakladnoy'),
                paymentType: inv.paymentType,
                paymentSource: inv.paymentSource,
                invoiceId: inv.id,
                invoiceNo: inv.invoiceNo,
                originalAmount: inv.originalAmount != null ? roundMoney(Number(inv.originalAmount)) : null,
                discountAmount: inv.discountAmount != null ? roundMoney(Number(inv.discountAmount)) : null,
                photoFileId: inv.imageFileId,
                verbatimText: inv.verbatimText,
                items: inv.items.map((it) => ({
                    rawName: (0, transliterate_1.toLatinUz)(it.rawName || "Noma'lum"),
                    quantity: Number(it.quantity),
                    unit: (0, transliterate_1.toLatinUz)(it.unit || 'dona'),
                    unitPrice: roundMoney(Number(it.unitPrice)),
                    totalPrice: roundMoney(Number(it.totalPrice)),
                    currency: it.currency,
                })),
            };
        }
        if (recordType === 'PULLAR') {
            const p = await prisma_1.prisma.supplierPayment.findFirst({
                where: { id: cleanRecordId, ownerId: cleanOwnerId },
                include: { supplier: { select: { id: true, name: true } } },
            });
            if (!p)
                return null;
            return {
                id: p.id,
                supplierId: p.supplierId,
                supplierName: (0, transliterate_1.toLatinUz)(p.supplier.name),
                category: 'PULLAR',
                type: 'PAYMENT',
                amount: roundMoney(Number(p.amount)),
                currency: p.currency,
                date: p.createdAt,
                createdAt: p.createdAt,
                note: (0, transliterate_1.toLatinUz)(p.comment || "To'lov"),
                paymentSource: p.paymentSource,
            };
        }
        return null;
    }
    /**
     * 3. Creates a RETURN (Vozvrat) transaction for a supplier.
     * IMPORTANT: Does NOT touch CashTransaction, SupplierPayment, or DailyRegister.
     */
    static async addSupplierReturn(ownerId, supplierId, amount, currency, note) {
        const cleanOwnerId = String(ownerId).trim();
        const cleanSupplierId = String(supplierId).trim();
        const cleanAmount = roundMoney(Math.abs(Number(amount || 0)));
        if (!cleanAmount || cleanAmount <= 0) {
            throw new Error("Vozvrat summasi 0 dan katta bo'lishi kerak.");
        }
        const cleanNote = note && note.trim() ? (0, transliterate_1.toLatinUz)(note.trim()) : 'Vozvrat (Tovar qaytarildi)';
        const result = await prisma_1.prisma.$transaction(async (tx) => {
            const existingSupplier = await tx.supplier.findFirst({
                where: { id: cleanSupplierId, ownerId: cleanOwnerId },
                select: { id: true, name: true },
            });
            if (!existingSupplier) {
                throw new Error("Ta'minotchi topilmadi yoki ruxsat yo'q.");
            }
            const transaction = await tx.supplierTransaction.create({
                data: {
                    ownerId: cleanOwnerId,
                    supplierId: cleanSupplierId,
                    type: 'RETURN',
                    sourceType: 'MANUAL',
                    paymentSource: 'RETURN',
                    amount: cleanAmount,
                    currency,
                    description: cleanNote,
                },
            });
            const { balance, supplier } = await this.computeAndSyncSupplierBalanceTx(tx, cleanOwnerId, cleanSupplierId);
            await tx.auditLog.create({
                data: {
                    telegramId: toAuditTelegramId(cleanOwnerId),
                    action: 'SUPPLIER_RETURN_ADD',
                    details: {
                        ownerId: cleanOwnerId,
                        supplierId: cleanSupplierId,
                        transactionId: transaction.id,
                        amount: cleanAmount,
                        currency,
                        note: cleanNote,
                    },
                },
            });
            return { transaction, supplier, balance };
        }, { maxWait: 15000, timeout: 30000 });
        cache_service_1.cacheService.invalidateSupplierNames(cleanOwnerId);
        return result;
    }
    /**
     * 4a. Updates the amount of a CHEKLAR, PULLAR, or VOZVRAT record.
     * Strictly enforces ownerId ownership, recalculates supplier balance, and logs to AuditLog.
     */
    static async updateSupplierRecordAmount(ownerId, recordType, recordId, newAmount) {
        const cleanOwnerId = String(ownerId).trim();
        const cleanRecordId = String(recordId).trim();
        const cleanNewAmount = roundMoney(Math.abs(Number(newAmount || 0)));
        if (!cleanNewAmount || cleanNewAmount <= 0) {
            throw new Error("Yangi summa 0 dan katta bo'lishi kerak.");
        }
        const expectedType = categoryToTransactionType(recordType);
        const result = await prisma_1.prisma.$transaction(async (tx) => {
            let supTx = await tx.supplierTransaction.findFirst({
                where: { id: cleanRecordId, ownerId: cleanOwnerId, type: expectedType },
            });
            let linkedInvoice = null;
            let linkedPayment = null;
            if (recordType === 'CHEKLAR') {
                if (supTx) {
                    const invId = supTx.invoiceId || supTx.receiptData?.invoiceId || null;
                    if (invId) {
                        linkedInvoice = await tx.invoice.findFirst({
                            where: { id: String(invId), ownerId: cleanOwnerId },
                        });
                    }
                }
                else {
                    linkedInvoice = await tx.invoice.findFirst({
                        where: { id: cleanRecordId, ownerId: cleanOwnerId },
                    });
                    if (linkedInvoice) {
                        supTx = await tx.supplierTransaction.findFirst({
                            where: { ownerId: cleanOwnerId, invoiceId: linkedInvoice.id, type: 'INCOMING_GOODS' },
                        });
                    }
                }
            }
            else if (recordType === 'PULLAR') {
                if (supTx) {
                    const windowStart = new Date(supTx.date.getTime() - 10_000);
                    const windowEnd = new Date(supTx.date.getTime() + 10_000);
                    linkedPayment = await tx.supplierPayment.findFirst({
                        where: {
                            ownerId: cleanOwnerId,
                            supplierId: supTx.supplierId,
                            currency: supTx.currency,
                            amount: supTx.amount,
                            createdAt: { gte: windowStart, lte: windowEnd },
                        },
                        orderBy: { createdAt: 'desc' },
                    });
                }
                else {
                    linkedPayment = await tx.supplierPayment.findFirst({
                        where: { id: cleanRecordId, ownerId: cleanOwnerId },
                    });
                    if (linkedPayment) {
                        const windowStart = new Date(linkedPayment.createdAt.getTime() - 10_000);
                        const windowEnd = new Date(linkedPayment.createdAt.getTime() + 10_000);
                        supTx = await tx.supplierTransaction.findFirst({
                            where: {
                                ownerId: cleanOwnerId,
                                supplierId: linkedPayment.supplierId,
                                type: 'PAYMENT',
                                currency: linkedPayment.currency,
                                amount: linkedPayment.amount,
                                date: { gte: windowStart, lte: windowEnd },
                            },
                            orderBy: { date: 'desc' },
                        });
                    }
                }
            }
            if (!supTx && !linkedInvoice && !linkedPayment) {
                throw new Error("Yozuv topilmadi yoki tahrirlashga ruxsat yo'q.");
            }
            const supplierId = supTx?.supplierId || linkedInvoice?.supplierId || linkedPayment?.supplierId;
            const currency = (linkedInvoice?.currency || supTx?.currency || linkedPayment?.currency);
            const oldAmount = roundMoney(Number(linkedInvoice ? linkedInvoice.totalAmount : supTx ? supTx.amount : linkedPayment.amount));
            if (recordType === 'CHEKLAR' && linkedInvoice) {
                const origRaw = Math.max(roundMoney(Number(linkedInvoice.originalAmount ?? cleanNewAmount)), cleanNewAmount);
                const discountAmt = roundMoney(Math.max(0, origRaw - cleanNewAmount));
                const payType = linkedInvoice.paymentType || 'CREDIT';
                const paidCashAmt = payType === 'CASH'
                    ? cleanNewAmount
                    : payType === 'PARTIAL'
                        ? Math.min(cleanNewAmount, roundMoney(Number(linkedInvoice.paidCashAmount || 0)))
                        : 0;
                const creditAmt = payType === 'CASH' ? 0 : roundMoney(Math.max(0, cleanNewAmount - paidCashAmt));
                await tx.invoice.update({
                    where: { id: linkedInvoice.id },
                    data: {
                        originalAmount: origRaw,
                        discountAmount: discountAmt,
                        totalAmount: cleanNewAmount,
                        paidCashAmount: paidCashAmt,
                        creditAmount: creditAmt,
                    },
                });
                if (payType === 'CASH' && oldAmount > 0) {
                    const winStart = new Date(linkedInvoice.createdAt.getTime() - 10_000);
                    const winEnd = new Date(linkedInvoice.createdAt.getTime() + 10_000);
                    const matchingCash = await tx.cashTransaction.findFirst({
                        where: {
                            ownerId: cleanOwnerId,
                            currency,
                            amount: oldAmount,
                            createdAt: { gte: winStart, lte: winEnd },
                        },
                        orderBy: { createdAt: 'desc' },
                    });
                    if (matchingCash) {
                        await tx.cashTransaction.update({
                            where: { id: matchingCash.id },
                            data: { amount: cleanNewAmount },
                        });
                    }
                }
            }
            if (recordType === 'PULLAR' && linkedPayment) {
                await tx.supplierPayment.update({
                    where: { id: linkedPayment.id },
                    data: { amount: cleanNewAmount },
                });
            }
            if (supTx) {
                await tx.supplierTransaction.update({
                    where: { id: supTx.id },
                    data: { amount: cleanNewAmount },
                });
            }
            const { balance, supplier } = await this.computeAndSyncSupplierBalanceTx(tx, cleanOwnerId, supplierId);
            if (recordType === 'CHEKLAR' && supTx && linkedInvoice) {
                const postDebt = currency === 'USD' ? balance.debtUsd : balance.debtUzs;
                const origRaw = Math.max(roundMoney(Number(linkedInvoice.originalAmount ?? cleanNewAmount)), cleanNewAmount);
                const discountAmt = roundMoney(Math.max(0, origRaw - cleanNewAmount));
                const formattedReceipt = this.buildFormattedReceiptText({
                    supplierName: supplier.name,
                    date: supTx.date,
                    verbatimText: linkedInvoice.verbatimText,
                    rawTotal: origRaw,
                    discountAmount: discountAmt,
                    finalTotal: cleanNewAmount,
                    currency,
                    postDebt,
                });
                await tx.supplierTransaction.update({
                    where: { id: supTx.id },
                    data: { originalAmount: origRaw, discountAmount: discountAmt, formattedReceipt },
                });
            }
            await tx.auditLog.create({
                data: {
                    telegramId: toAuditTelegramId(cleanOwnerId),
                    action: `SUPPLIER_RECORD_UPDATE_${recordType}`,
                    details: {
                        ownerId: cleanOwnerId,
                        supplierId,
                        recordType,
                        recordId: cleanRecordId,
                        oldAmount,
                        newAmount: cleanNewAmount,
                        currency,
                    },
                },
            });
            return {
                recordId: cleanRecordId,
                recordType,
                supplierId,
                supplier,
                balance,
                oldAmount,
                newAmount: cleanNewAmount,
                currency,
            };
        }, { maxWait: 15000, timeout: 30000 });
        cache_service_1.cacheService.invalidateSupplierNames(cleanOwnerId);
        return result;
    }
    /**
     * 4b. Deletes a CHEKLAR, PULLAR, or VOZVRAT record.
     * Strictly enforces ownerId ownership, recalculates supplier balance, and logs to AuditLog.
     */
    static async deleteSupplierRecord(ownerId, recordType, recordId) {
        const cleanOwnerId = String(ownerId).trim();
        const cleanRecordId = String(recordId).trim();
        const expectedType = categoryToTransactionType(recordType);
        const result = await prisma_1.prisma.$transaction(async (tx) => {
            let supTx = await tx.supplierTransaction.findFirst({
                where: { id: cleanRecordId, ownerId: cleanOwnerId, type: expectedType },
            });
            let linkedInvoice = null;
            let linkedPayment = null;
            if (recordType === 'CHEKLAR') {
                if (supTx) {
                    const invId = supTx.invoiceId || supTx.receiptData?.invoiceId || null;
                    if (invId) {
                        linkedInvoice = await tx.invoice.findFirst({
                            where: { id: String(invId), ownerId: cleanOwnerId },
                        });
                    }
                }
                else {
                    linkedInvoice = await tx.invoice.findFirst({
                        where: { id: cleanRecordId, ownerId: cleanOwnerId },
                    });
                    if (linkedInvoice) {
                        supTx = await tx.supplierTransaction.findFirst({
                            where: { ownerId: cleanOwnerId, invoiceId: linkedInvoice.id, type: 'INCOMING_GOODS' },
                        });
                    }
                }
            }
            else if (recordType === 'PULLAR') {
                if (supTx) {
                    const windowStart = new Date(supTx.date.getTime() - 10_000);
                    const windowEnd = new Date(supTx.date.getTime() + 10_000);
                    linkedPayment = await tx.supplierPayment.findFirst({
                        where: {
                            ownerId: cleanOwnerId,
                            supplierId: supTx.supplierId,
                            currency: supTx.currency,
                            amount: supTx.amount,
                            createdAt: { gte: windowStart, lte: windowEnd },
                        },
                        orderBy: { createdAt: 'desc' },
                    });
                }
                else {
                    linkedPayment = await tx.supplierPayment.findFirst({
                        where: { id: cleanRecordId, ownerId: cleanOwnerId },
                    });
                    if (linkedPayment) {
                        const windowStart = new Date(linkedPayment.createdAt.getTime() - 10_000);
                        const windowEnd = new Date(linkedPayment.createdAt.getTime() + 10_000);
                        supTx = await tx.supplierTransaction.findFirst({
                            where: {
                                ownerId: cleanOwnerId,
                                supplierId: linkedPayment.supplierId,
                                type: 'PAYMENT',
                                currency: linkedPayment.currency,
                                amount: linkedPayment.amount,
                                date: { gte: windowStart, lte: windowEnd },
                            },
                            orderBy: { date: 'desc' },
                        });
                    }
                }
            }
            if (!supTx && !linkedInvoice && !linkedPayment) {
                throw new Error("Yozuv topilmadi yoki o'chirishga ruxsat yo'q.");
            }
            const supplierId = supTx?.supplierId || linkedInvoice?.supplierId || linkedPayment?.supplierId;
            const currency = (linkedInvoice?.currency || supTx?.currency || linkedPayment?.currency);
            const deletedAmount = roundMoney(Number(linkedInvoice ? linkedInvoice.totalAmount : supTx ? supTx.amount : linkedPayment.amount));
            const description = supTx?.description || linkedPayment?.comment || linkedInvoice?.invoiceNo || null;
            if (recordType === 'CHEKLAR' && linkedInvoice) {
                const paidCashAmt = roundMoney(Number(linkedInvoice.paidCashAmount || 0));
                if (paidCashAmt > 0) {
                    const winStart = new Date(linkedInvoice.createdAt.getTime() - 10_000);
                    const winEnd = new Date(linkedInvoice.createdAt.getTime() + 10_000);
                    const matchingCash = await tx.cashTransaction.findFirst({
                        where: {
                            ownerId: cleanOwnerId,
                            currency,
                            amount: paidCashAmt,
                            createdAt: { gte: winStart, lte: winEnd },
                        },
                        orderBy: { createdAt: 'desc' },
                    });
                    if (matchingCash) {
                        await tx.cashTransaction.delete({ where: { id: matchingCash.id } });
                    }
                }
                await tx.invoice.delete({ where: { id: linkedInvoice.id } });
            }
            if (recordType === 'PULLAR' && linkedPayment) {
                await tx.supplierPayment.delete({ where: { id: linkedPayment.id } });
            }
            if (supTx) {
                await tx.supplierTransaction.delete({ where: { id: supTx.id } });
            }
            const { balance, supplier } = await this.computeAndSyncSupplierBalanceTx(tx, cleanOwnerId, supplierId);
            await tx.auditLog.create({
                data: {
                    telegramId: toAuditTelegramId(cleanOwnerId),
                    action: `SUPPLIER_RECORD_DELETE_${recordType}`,
                    details: {
                        ownerId: cleanOwnerId,
                        supplierId,
                        recordType,
                        recordId: cleanRecordId,
                        deletedAmount,
                        currency,
                        description,
                    },
                },
            });
            return {
                deleted: true,
                recordId: cleanRecordId,
                recordType,
                supplierId,
                supplier,
                balance,
                deletedAmount,
                currency,
            };
        }, { maxWait: 15000, timeout: 30000 });
        cache_service_1.cacheService.invalidateSupplierNames(cleanOwnerId);
        return result;
    }
    /**
     * 5. Fetches ALL incoming goods, payments, and returns for a supplier from day 0 to today,
     * merged and sorted chronologically (createdAt asc) for Sverka / PDF generation.
     */
    static async getSupplierFullHistory(ownerId, supplierId) {
        const cleanOwnerId = String(ownerId).trim();
        const cleanSupplierId = String(supplierId).trim();
        const supplier = await prisma_1.prisma.supplier.findFirst({
            where: { id: cleanSupplierId, ownerId: cleanOwnerId },
            select: { id: true, ownerId: true, name: true, phone: true },
        });
        if (!supplier) {
            throw new Error("Ta'minotchi topilmadi yoki ruxsat yo'q.");
        }
        const [transactions, invoices, payments] = await Promise.all([
            prisma_1.prisma.supplierTransaction.findMany({
                where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                orderBy: { date: 'asc' },
            }),
            prisma_1.prisma.invoice.findMany({
                where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                orderBy: { createdAt: 'asc' },
            }),
            prisma_1.prisma.supplierPayment.findMany({
                where: { ownerId: cleanOwnerId, supplierId: cleanSupplierId },
                orderBy: { createdAt: 'asc' },
            }),
        ]);
        const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
        const linkedInvoiceIds = new Set();
        const paymentTxMarkers = [];
        const entries = [];
        for (const tx of transactions) {
            if (tx.type === 'INCOMING_GOODS') {
                const invId = tx.invoiceId || tx.receiptData?.invoiceId || null;
                const inv = invId ? invoiceMap.get(String(invId)) : undefined;
                if (inv)
                    linkedInvoiceIds.add(inv.id);
                const cur = (inv?.currency || tx.currency);
                const totalAmt = roundMoney(Math.abs(Number(inv ? inv.totalAmount : tx.amount)));
                const payType = inv?.paymentType || tx.receiptData?.paymentType || 'CREDIT';
                const paidCash = payType === 'CASH'
                    ? totalAmt
                    : payType === 'PARTIAL'
                        ? Math.min(totalAmt, roundMoney(Math.abs(Number(inv?.paidCashAmount ?? tx.receiptData?.paidCashAmount ?? 0))))
                        : 0;
                const invLabel = inv?.invoiceNo ? `Nakladnoy #${inv.invoiceNo}` : (0, transliterate_1.toLatinUz)(tx.description || 'Yuk keldi');
                const noteSuffix = payType === 'CASH' ? ' (Naqd)' : payType === 'PARTIAL' ? ' (Qisman naqd)' : '';
                entries.push({
                    id: tx.id,
                    date: tx.date,
                    createdAt: tx.date,
                    type: 'INCOMING_GOODS',
                    actionLabel: 'Yuk keldi (+)',
                    amount: totalAmt,
                    currency: cur,
                    note: (0, transliterate_1.toLatinUz)(`${invLabel}${invLabel.includes('(') ? '' : noteSuffix}`).trim(),
                    paymentType: payType,
                });
                if (paidCash > 0) {
                    entries.push({
                        id: `${tx.id}:cash`,
                        date: tx.date,
                        createdAt: tx.date,
                        type: 'PAYMENT',
                        actionLabel: 'Pul berildi (-)',
                        amount: paidCash,
                        currency: cur,
                        note: (0, transliterate_1.toLatinUz)(payType === 'CASH'
                            ? `Naqd to'lov (${inv?.invoiceNo ? `#${inv.invoiceNo}` : 'Nakladnoy'})`
                            : `Qisman naqd to'lov (${inv?.invoiceNo ? `#${inv.invoiceNo}` : 'Nakladnoy'})`),
                        paymentType: payType,
                    });
                }
            }
            else if (tx.type === 'PAYMENT') {
                const amt = roundMoney(Math.abs(Number(tx.amount)));
                paymentTxMarkers.push({
                    currency: tx.currency,
                    amount: amt,
                    time: tx.date.getTime(),
                    matched: false,
                });
                entries.push({
                    id: tx.id,
                    date: tx.date,
                    createdAt: tx.date,
                    type: 'PAYMENT',
                    actionLabel: 'Pul berildi (-)',
                    amount: amt,
                    currency: tx.currency,
                    note: (0, transliterate_1.toLatinUz)(tx.description ||
                        (tx.paymentSource === 'PREVIOUS_SAFE'
                            ? "Seyfdan to'lov"
                            : "Kassadan to'lov")),
                });
            }
            else if (tx.type === 'RETURN') {
                entries.push({
                    id: tx.id,
                    date: tx.date,
                    createdAt: tx.date,
                    type: 'RETURN',
                    actionLabel: 'Vozvrat (-)',
                    amount: roundMoney(Math.abs(Number(tx.amount))),
                    currency: tx.currency,
                    note: (0, transliterate_1.toLatinUz)(tx.description || 'Tovar qaytarildi'),
                });
            }
        }
        // Add orphan invoices if any exist without SupplierTransaction
        for (const inv of invoices) {
            if (linkedInvoiceIds.has(inv.id))
                continue;
            const totalAmt = roundMoney(Math.abs(Number(inv.totalAmount)));
            const paidCash = inv.paymentType === 'CASH'
                ? totalAmt
                : inv.paymentType === 'PARTIAL'
                    ? Math.min(totalAmt, roundMoney(Math.abs(Number(inv.paidCashAmount || 0))))
                    : 0;
            entries.push({
                id: inv.id,
                date: inv.createdAt,
                createdAt: inv.createdAt,
                type: 'INCOMING_GOODS',
                actionLabel: 'Yuk keldi (+)',
                amount: totalAmt,
                currency: inv.currency,
                note: (0, transliterate_1.toLatinUz)(inv.invoiceNo ? `Nakladnoy #${inv.invoiceNo}` : 'Nakladnoy'),
                paymentType: inv.paymentType,
            });
            if (paidCash > 0) {
                entries.push({
                    id: `${inv.id}:cash`,
                    date: inv.createdAt,
                    createdAt: inv.createdAt,
                    type: 'PAYMENT',
                    actionLabel: 'Pul berildi (-)',
                    amount: paidCash,
                    currency: inv.currency,
                    note: (0, transliterate_1.toLatinUz)(inv.paymentType === 'CASH' ? "Naqd to'lov" : "Qisman naqd to'lov"),
                    paymentType: inv.paymentType,
                });
            }
        }
        // Add orphan payments if any exist without SupplierTransaction
        for (const p of payments) {
            const pAmt = roundMoney(Math.abs(Number(p.amount)));
            const pTime = p.createdAt.getTime();
            const match = paymentTxMarkers.find((m) => !m.matched &&
                m.currency === p.currency &&
                Math.abs(m.amount - pAmt) < 0.01 &&
                Math.abs(m.time - pTime) <= 10_000);
            if (match) {
                match.matched = true;
                continue;
            }
            entries.push({
                id: p.id,
                date: p.createdAt,
                createdAt: p.createdAt,
                type: 'PAYMENT',
                actionLabel: 'Pul berildi (-)',
                amount: pAmt,
                currency: p.currency,
                note: (0, transliterate_1.toLatinUz)(p.comment || "To'lov"),
            });
        }
        const typeOrder = {
            INCOMING_GOODS: 0,
            PAYMENT: 1,
            RETURN: 2,
        };
        entries.sort((a, b) => {
            const diff = a.createdAt.getTime() - b.createdAt.getTime();
            if (diff !== 0)
                return diff;
            return typeOrder[a.type] - typeOrder[b.type];
        });
        const summary = computeSupplierBalanceFromLedger(cleanOwnerId, cleanSupplierId, {
            transactions,
            invoices,
            payments,
        });
        return {
            supplier: {
                id: supplier.id,
                ownerId: supplier.ownerId,
                name: (0, transliterate_1.toLatinUz)(supplier.name),
                phone: supplier.phone,
            },
            entries,
            summary,
            firstDate: entries.length > 0 ? entries[0].createdAt : null,
            lastDate: entries.length > 0 ? entries[entries.length - 1].createdAt : null,
        };
    }
}
exports.SupplierService = SupplierService;
exports.getSupplierBalance = SupplierService.getSupplierBalance.bind(SupplierService);
exports.getSupplierRecordsPaginated = SupplierService.getSupplierRecordsPaginated.bind(SupplierService);
exports.getSupplierRecordDetail = SupplierService.getSupplierRecordDetail.bind(SupplierService);
exports.addSupplierReturn = SupplierService.addSupplierReturn.bind(SupplierService);
exports.updateSupplierRecordAmount = SupplierService.updateSupplierRecordAmount.bind(SupplierService);
exports.deleteSupplierRecord = SupplierService.deleteSupplierRecord.bind(SupplierService);
exports.getSupplierFullHistory = SupplierService.getSupplierFullHistory.bind(SupplierService);
