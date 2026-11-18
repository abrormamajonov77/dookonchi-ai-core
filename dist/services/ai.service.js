"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiService = exports.COMPACT_SCANNER_PROMPT = exports.VoiceIntentSchema = exports.InvoiceSchema = exports.InvoiceItemSchema = exports.DEFAULT_GENERATION_CONFIG = void 0;
exports.generateContentWithFallback = generateContentWithFallback;
exports.parseCompactScannerRows = parseCompactScannerRows;
exports.parseVerbatimTableToItems = parseVerbatimTableToItems;
exports.buildVerbatimTableText = buildVerbatimTableText;
exports.normalizeVerbatimInvoice = normalizeVerbatimInvoice;
const genai_1 = require("@google/genai");
const zod_1 = require("zod");
const env_1 = require("../config/env");
const retry_1 = require("../utils/retry");
const logger_1 = require("../config/logger");
const transliterate_1 = require("../utils/transliterate");
const formatters_1 = require("../utils/formatters");
const ai = new genai_1.GoogleGenAI({ apiKey: env_1.env.GEMINI_API_KEY });
exports.DEFAULT_GENERATION_CONFIG = {
    temperature: 0.1,
    maxOutputTokens: 4096,
};
exports.InvoiceItemSchema = zod_1.z
    .object({
    rawName: zod_1.z.string().optional(),
    normalizedName: zod_1.z.string().optional(),
    productName: zod_1.z.string().optional(),
    quantity: zod_1.z.number().default(1),
    unit: zod_1.z.string().optional().default('dona'),
    unitPrice: zod_1.z.number().default(0),
    lineTotal: zod_1.z.number().optional(),
    totalPrice: zod_1.z.number().optional(),
    currency: zod_1.z.enum(['UZS', 'USD']).optional().default('UZS'),
})
    .transform((item) => {
    const rawName = (0, transliterate_1.toLatinUz)((item.rawName || item.productName || "Noma'lum tovar").trim());
    const normalizedName = (0, transliterate_1.normalizeForSearch)(item.normalizedName || rawName) || rawName.toLowerCase();
    const quantity = Number(item.quantity || 1);
    const unitPrice = Number(Number(item.unitPrice || 0).toFixed(2));
    const computedLine = Number((quantity * unitPrice).toFixed(2));
    const rawLine = item.lineTotal ?? item.totalPrice ?? computedLine;
    const lineTotal = Number(Number(rawLine).toFixed(2));
    const unit = (0, transliterate_1.toLatinUz)(item.unit || 'dona').trim() || 'dona';
    return {
        rawName,
        normalizedName,
        productName: rawName,
        quantity,
        unit,
        unitPrice,
        lineTotal,
        totalPrice: lineTotal,
        currency: item.currency || 'UZS',
    };
});
exports.InvoiceSchema = zod_1.z.object({
    total_amount: zod_1.z.number().default(0),
    rawTotal: zod_1.z.number().optional().nullable(),
    subtotalBeforeDiscount: zod_1.z.number().optional().nullable(),
    discountPercent: zod_1.z.number().optional().nullable(),
    discount: zod_1.z.number().default(0),
    finalTotal: zod_1.z.number().optional().nullable(),
    printedFinalTotal: zod_1.z.number().optional().nullable(),
    currency: zod_1.z.enum(['UZS', 'USD']).default('UZS'),
    verbatimText: zod_1.z.string().default(''),
    table_text: zod_1.z.string().default(''),
    supplier: zod_1.z.string().optional().nullable(),
    invoiceNo: zod_1.z.string().optional().nullable(),
    invoiceNumber: zod_1.z.string().optional().nullable(),
    invoiceDate: zod_1.z.string().optional().nullable(),
    supplierName: zod_1.z.string().optional().nullable(),
    grossTotal: zod_1.z.number().optional().nullable(),
    discountAmount: zod_1.z.number().optional().nullable(),
    netTotal: zod_1.z.number().optional().nullable(),
    itemsCount: zod_1.z.number().optional().nullable(),
    sampleItems: zod_1.z.array(zod_1.z.string()).optional().nullable(),
    rows: zod_1.z.array(zod_1.z.string()).optional().nullable(),
    items: zod_1.z.any().optional().nullable(),
    isCaptionOverride: zod_1.z.boolean().optional(),
    isCashOverride: zod_1.z.boolean().optional(),
    exactSupplierId: zod_1.z.string().optional().nullable(),
    discountLabel: zod_1.z.string().optional().nullable(),
    imageHash: zod_1.z.string().optional().nullable(),
    contentFingerprint: zod_1.z.string().optional().nullable(),
});
exports.VoiceIntentSchema = zod_1.z.object({
    intent: zod_1.z.enum([
        'ADD_EXPENSE',
        'ADD_SUPPLIER_TX',
        'ADD_CUSTOMER_DEBT',
        'ADD_CASH_TX',
        'SEARCH_PRODUCT',
        'GET_DEBT_INFO',
        'GENERAL_CHAT',
        'UNKNOWN',
    ]),
    txType: zod_1.z.enum(['INCOMING_GOODS', 'PAYMENT']).optional().nullable(),
    amount: zod_1.z.number().optional().nullable(),
    currency: zod_1.z.enum(['UZS', 'USD']).nullable().optional().default('UZS'),
    name: zod_1.z.string().optional().nullable(),
    category: zod_1.z.string().optional().nullable(),
    comment: zod_1.z.string().optional().nullable(),
    replyText: zod_1.z.string().optional().nullable(),
});
const INTENT_RULES = `Maqsadlar (intent):
- ADD_EXPENSE: Xarajat kiritish (masalan: "Ijaraga 500 dollar berdim", "Elektrga 200 ming so'm to'ladim").
- ADD_SUPPLIER_TX: Ta'minotchi bilan oldi-berdi amaliyoti (qarzga).
  * Agar "Yuk keldi / yuk chiqdi / yuk oldik" yoki musbat amaliyot bo'lsa -> txType="INCOMING_GOODS".
  * Agar "Pul berdik / to'ladik / to'lov qildim / qarzdan ayir / ayirdim" yoki manfiy amaliyot bo'lsa -> txType="PAYMENT".
- ADD_CASH_TX: Naqd xarid yoki naqd savdo (masalan: "Naqdga 500 minglik yuk oldim").
- ADD_CUSTOMER_DEBT: Nasiyaga mol berish/mijoz qarzi.
- SEARCH_PRODUCT: Tovarni qidirish (masalan: "Kola narxi qancha?").
- GET_DEBT_INFO: FAQAT qarz miqdorini SO'RASH (masalan: "Milterdan qancha qarzim bor?").
- GENERAL_CHAT: Erkin savdo maslahati.
- UNKNOWN: Tushunarsiz bo'lsa.
Barcha ismlar va tovar nomlarini O'zbek Lotin alifbosiga o'girib qaytar! Javob faqat JSON formatda bo'lsin.`;
exports.COMPACT_SCANNER_PROMPT = `Sen ultra-tezkor kassa skaner apparatisansan (2-3s Single-Pass Scanner Mode).
DIQQAT: Agar rasmdagi nakladnoy teskari (180 daraja oyog'i osmondan) yoki yonbosh tushgan bo'lsa ham, uni o'zing to'g'rilab o'qi! Barcha qatorlarni 1-qatordan oxirgi qatorgacha hech birini qoldirmasdan o'qi va barcha Kirill harflarini darhol O'zbek Lotin alifbosiga (masalan: 'Ярко Кетчуп' -> 'Yarko Ketchup') o'girib qaytar!
Agar rasmda matn ko'rinmasa yoki bo'sh bo'lsa, rows: [] va 0 summalar bilan bir qatorli ixcham JSON qaytar.

QOIDA:
1. Uzun jadval yozma! Faqat "rows" massivida har bir qatorni "№|Lotincha Nomi|Soni va birligi|1 dona narxi|Qator jami summasi" formatida qaytar.
2. Eng pastdagi skidkagacha bo'lgan jami summani (subtotalBeforeDiscount), skidka foizini (discountPercent), skidka summasini (discountAmount) va qog'ozda yozilgan yakuniy summani (printedFinalTotal) yoz.
3. Agar $, USD, USDT, у.е. bo'lsa yoki narxlar kichik kasr sonlarda (1.25, 102.17) bo'lsa -> currency="USD", aks holda "UZS". Sentlarni aslo yaxlitlama!

Javobni FAQAT ixcham (minifikatsiya qilingan) JSON formatda qaytar:
{"supplierName":"Milter","invoiceNumber":"145","invoiceDate":"2026-11-17","currency":"UZS","rows":["1|Yarko Ketchup|10 kor|45000|450000"],"subtotalBeforeDiscount":450000,"discountPercent":0,"discountAmount":0,"printedFinalTotal":450000}`;
function getCandidateModels(explicitModels) {
    const envModel = process.env.GEMINI_MODEL?.trim();
    const base = explicitModels && explicitModels.length > 0
        ? explicitModels
        : [
            'gemini-3-flash-preview',
            'gemini-flash-lite-latest',
            'gemini-3.1-flash-lite-preview',
            'gemini-flash-latest',
            'gemini-3.8-flash',
        ];
    return Array.from(new Set([...(envModel ? [envModel] : []), ...base]));
}
function extractCleanJson(rawText) {
    const trimmed = (rawText || '').trim();
    if (!trimmed)
        throw new Error('Empty response from Gemini');
    const stripped = trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    try {
        return JSON.parse(stripped);
    }
    catch {
        const start = stripped.indexOf('{');
        const end = stripped.lastIndexOf('}');
        if (start !== -1 && end > start) {
            return JSON.parse(stripped.slice(start, end + 1));
        }
        throw new Error('Invalid JSON response from Gemini');
    }
}
async function generateContentWithFallback(aiCall, models) {
    const candidateModels = getCandidateModels(models);
    let lastError = null;
    for (const model of candidateModels) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            let timer;
            try {
                return await Promise.race([
                    aiCall(model),
                    new Promise((_, rej) => {
                        timer = setTimeout(() => rej(new Error(`Model ${model} request timed out (15s)`)), 15000);
                    }),
                ]);
            }
            catch (error) {
                lastError = error;
                const isTransient = error?.status === 503 || /503|fetch failed|ECONNRESET/i.test(error?.message || '');
                if (isTransient && attempt < 2) {
                    logger_1.logger.warn(`Model ${model} busy (${error?.message?.slice(0, 60)}), retrying...`);
                    await new Promise((res) => setTimeout(res, 500));
                    continue;
                }
                logger_1.logger.warn(`Model ${model} failed: ${error?.message?.slice(0, 120)}`);
                break;
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
        }
    }
    throw lastError;
}
const askJson = async (parts, maxOutputTokens = exports.DEFAULT_GENERATION_CONFIG.maxOutputTokens, models) => {
    return generateContentWithFallback(async (model) => {
        const res = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
                responseMimeType: 'application/json',
                temperature: exports.DEFAULT_GENERATION_CONFIG.temperature,
                maxOutputTokens,
            },
        });
        if (!res.text)
            throw new Error('Empty response from Gemini');
        return extractCleanJson(res.text);
    }, models);
};
/**
 * MODUL 1.3 & MODUL 3: Ultra-fast (<0.001s) Node.js parser for compact scanner `rows` ("№|Nomi|Soni|Narxi|Summasi").
 * Automatically converts all Cyrillic item names and units to Uzbek Latin (`toLatinUz`).
 */
function parseCompactScannerRows(rows, defaultCurrency = 'UZS') {
    if (!Array.isArray(rows) || rows.length === 0)
        return [];
    const items = [];
    for (const rawRow of rows) {
        if (!rawRow || typeof rawRow !== 'string')
            continue;
        const cols = rawRow
            .split('|')
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
        if (cols.length < 2)
            continue;
        const firstIsIndex = /^\d+\.?$/.test(cols[0]) && cols.length >= 4;
        const rawName = (firstIsIndex ? cols[1] : cols[0]) || "Noma'lum tovar";
        const qtyCol = (firstIsIndex ? cols[2] : cols[1]) || '1 dona';
        const priceCol = (firstIsIndex ? cols[3] : cols[2]) || '0';
        const totalCol = (firstIsIndex ? cols[4] : cols[3]) || '';
        const qtyMatch = qtyCol.match(/(\d+(?:[.,]\d+)?)\s*(.*)/);
        const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) || 1 : 1;
        const unitRaw = (qtyMatch?.[2] || '').replace(/[xх*]/gi, '').trim() || 'dona';
        const unit = (0, transliterate_1.toLatinUz)(unitRaw) || 'dona';
        const parsedPrice = (0, formatters_1.parseCurrencyAndAmount)(priceCol);
        const itemCurrency = parsedPrice.currency === 'USD' || /\$/i.test(priceCol) || /\$/i.test(totalCol) ? 'USD' : defaultCurrency;
        const unitPrice = Number(parsedPrice.amount.toFixed(2));
        const parsedTotal = totalCol ? (0, formatters_1.parseCurrencyAndAmount)(totalCol).amount : Number((quantity * unitPrice).toFixed(2));
        const lineTotal = Number((parsedTotal > 0 ? parsedTotal : quantity * unitPrice).toFixed(2));
        const cleanRawName = (0, transliterate_1.toLatinUz)(rawName.trim());
        const normalizedName = (0, transliterate_1.normalizeForSearch)(cleanRawName) || cleanRawName.toLowerCase();
        items.push({
            rawName: cleanRawName,
            normalizedName,
            productName: cleanRawName,
            quantity,
            unit,
            unitPrice,
            lineTotal,
            totalPrice: lineTotal,
            currency: itemCurrency,
        });
    }
    return items;
}
function parseVerbatimTableToItems(tableText, defaultCurrency = 'UZS') {
    if (!tableText || !tableText.trim())
        return [];
    const lines = tableText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const extracted = [];
    for (const line of lines) {
        if (/^\|?[\s\-:|]+\|?$/.test(line))
            continue;
        if (line.includes('|')) {
            const cols = line
                .split('|')
                .map((c) => c.trim())
                .filter(Boolean);
            if (cols.length < 2)
                continue;
            const joinedLower = cols.join(' ').toLowerCase();
            if ((joinedLower.includes('mahsulot') || joinedLower.includes('tovar') || joinedLower.includes('наименование')) &&
                (joinedLower.includes('narx') || joinedLower.includes('soni') || joinedLower.includes('цена') || joinedLower.includes('сумма'))) {
                continue;
            }
            const firstIsIndex = /^\d+\.?$/.test(cols[0]) && cols.length >= 4;
            const nameCol = (0, transliterate_1.toLatinUz)(firstIsIndex ? cols[1] : cols[0]);
            const qtyCol = firstIsIndex ? cols[2] : cols[1] || '1';
            const priceCol = firstIsIndex ? cols[3] : cols[2] || '0';
            const totalCol = firstIsIndex ? cols[4] : cols[3] || '';
            const qtyMatch = qtyCol.match(/(\d+(?:[.,]\d+)?)\s*(.*)/);
            const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) || 1 : 1;
            const unit = (0, transliterate_1.toLatinUz)((qtyMatch?.[2] || '').replace(/[xх*]/gi, '').trim()) || 'dona';
            const parsedPrice = (0, formatters_1.parseCurrencyAndAmount)(priceCol);
            const itemCurrency = parsedPrice.currency === 'USD' || /\$/i.test(priceCol) || /\$/i.test(totalCol) ? 'USD' : defaultCurrency;
            const unitPrice = parsedPrice.amount;
            const parsedTotal = totalCol ? (0, formatters_1.parseCurrencyAndAmount)(totalCol).amount : Number((quantity * unitPrice).toFixed(2));
            const lineTotal = parsedTotal > 0 ? parsedTotal : Number((quantity * unitPrice).toFixed(2));
            extracted.push(exports.InvoiceItemSchema.parse({
                rawName: nameCol,
                normalizedName: (0, transliterate_1.normalizeForSearch)(nameCol),
                quantity,
                unit,
                unitPrice,
                lineTotal,
                currency: itemCurrency,
            }));
        }
    }
    return extracted;
}
function buildVerbatimTableText(items, currency = 'UZS') {
    if (!items || items.length === 0)
        return '';
    const header = `| № | Mahsulot nomi | Soni | 1 dona narxi | Jami summasi |\n|---|---|---|---|---|`;
    const rows = items.map((it, idx) => {
        const cur = it.currency || currency;
        const nameText = (0, transliterate_1.toLatinUz)(it.rawName || it.productName || '');
        const qtyText = `${it.quantity} ${(0, transliterate_1.toLatinUz)(it.unit || 'dona')}`.trim();
        const priceText = (0, formatters_1.formatCurrency)(it.unitPrice, cur);
        const totalText = (0, formatters_1.formatCurrency)(it.lineTotal ?? it.totalPrice, cur);
        return `| ${idx + 1} | ${nameText} | ${qtyText} | ${priceText} | ${totalText} |`;
    });
    return [header, ...rows].join('\n');
}
function normalizeVerbatimInvoice(raw, caption) {
    const parsedCaptionCurrency = caption ? (0, formatters_1.parseCurrencyAndAmount)(caption) : null;
    let currency = raw.currency === 'USD' ||
        parsedCaptionCurrency?.currency === 'USD' ||
        /\$|usd|usdt|у\.е/i.test(String(raw.verbatimText || raw.table_text || (raw.rows || []).join(' ')))
        ? 'USD'
        : 'UZS';
    let items = [];
    if (Array.isArray(raw.rows) && raw.rows.length > 0) {
        items = parseCompactScannerRows(raw.rows, currency);
    }
    else if (Array.isArray(raw.items) && raw.items.length > 0) {
        items = raw.items.map((it) => exports.InvoiceItemSchema.parse({
            ...it,
            currency: it.currency === 'USD' ? 'USD' : currency,
        }));
    }
    else if (raw.verbatimText || raw.table_text) {
        items = parseVerbatimTableToItems(String(raw.verbatimText || raw.table_text), currency);
    }
    if (items.some((i) => i.currency === 'USD')) {
        currency = 'USD';
    }
    const itemsSum = items.reduce((acc, it) => acc + Number(it.lineTotal || it.totalPrice || 0), 0);
    const subtotalBeforeDiscount = Number(raw.subtotalBeforeDiscount ?? raw.rawTotal ?? raw.originalAmount ?? raw.grossTotal ?? raw.total_amount ?? 0);
    const printedFinalTotal = Number(raw.printedFinalTotal ?? raw.finalTotal ?? raw.netTotal ?? subtotalBeforeDiscount ?? itemsSum ?? 0);
    const discountPercent = raw.discountPercent ?? null;
    const discountAmountInput = raw.discountLabel ?? raw.discountAmount ?? raw.discount ?? 0;
    // Double-Discount Guard reconciliation
    const reconciled = (0, formatters_1.reconcileInvoiceTotals)({
        rows: items,
        itemsSum,
        subtotalBeforeDiscount,
        discountPercent,
        discountAmount: discountAmountInput,
        printedFinalTotal,
    });
    const verbatimText = items.length > 0
        ? buildVerbatimTableText(items, currency)
        : (0, transliterate_1.toLatinUz)(String(raw.verbatimText || raw.table_text || '').trim());
    const supplierName = (0, transliterate_1.toLatinUz)((caption || raw.supplierName || raw.supplier || "Noma'lum").trim());
    const invoiceNo = raw.invoiceNumber ?? raw.invoiceNo ?? null;
    const discountLabel = raw.discountLabel || (reconciled.discountPercent > 0 ? `${reconciled.discountPercent}%` : null);
    return exports.InvoiceSchema.parse({
        ...raw,
        currency,
        invoiceNo,
        invoiceNumber: invoiceNo,
        subtotalBeforeDiscount: reconciled.rawTotal,
        rawTotal: reconciled.rawTotal,
        total_amount: reconciled.rawTotal,
        grossTotal: reconciled.rawTotal,
        discountPercent: reconciled.discountPercent,
        discount: reconciled.discountAmount,
        discountAmount: reconciled.discountAmount,
        printedFinalTotal: reconciled.finalTotal,
        finalTotal: reconciled.finalTotal,
        netTotal: reconciled.finalTotal,
        discountLabel,
        verbatimText,
        table_text: verbatimText,
        supplier: supplierName,
        supplierName,
        items,
        itemsCount: items.length || raw.itemsCount || 1,
        sampleItems: items.map((it) => `${it.rawName} | ${it.quantity} ${it.unit || 'dona'} x ${(0, formatters_1.formatCurrency)(it.unitPrice, it.currency || currency)} = ${(0, formatters_1.formatCurrency)(it.lineTotal, it.currency || currency)}`),
    });
}
class AiService {
    static DEFAULT_GENERATION_CONFIG = exports.DEFAULT_GENERATION_CONFIG;
    static async parseInvoiceImage(imageBuffer, _mimeType = 'image/jpeg', caption) {
        if (!imageBuffer || imageBuffer.byteLength === 0) {
            throw new Error("Nakladnoy rasm fayli bo'sh");
        }
        return (0, retry_1.withRetry)(async () => {
            logger_1.logger.info('Sending invoice image to Gemini for Single-Pass Compact Scanner OCR');
            const parsed = await askJson([
                { text: exports.COMPACT_SCANNER_PROMPT },
                { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
            ], exports.DEFAULT_GENERATION_CONFIG.maxOutputTokens);
            return normalizeVerbatimInvoice(parsed, caption);
        }, 2, 800, 90000);
    }
    static async parseInvoiceText(invoiceText) {
        return (0, retry_1.withRetry)(async () => {
            const prompt = `${exports.COMPACT_SCANNER_PROMPT}\n\nFoydalanuvchi quyidagi nakladnoy matnini yubordi. Barcha qatorlarni rows massiviga va yakuniy raqamlarga ajrat:\nMatn: "${invoiceText}"`;
            const parsed = await askJson([{ text: prompt }], exports.DEFAULT_GENERATION_CONFIG.maxOutputTokens);
            return normalizeVerbatimInvoice(parsed);
        }, 2, 800, 30000);
    }
    static async parseVoiceNote(audioBuffer, mimeType = 'audio/ogg') {
        return (0, retry_1.withRetry)(async () => {
            logger_1.logger.info('Sending voice note to Gemini for analysis');
            const raw = await askJson([
                {
                    text: `Sen do'kon yordamchisisan. Ovozli xabarni eshitib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.\n${INTENT_RULES}`,
                },
                { inlineData: { data: audioBuffer.toString('base64'), mimeType } },
            ]);
            if (raw.amount !== undefined && raw.amount !== null) {
                raw.amount = Number(Number(Math.abs(raw.amount)).toFixed(2));
            }
            if (raw.name) {
                raw.name = (0, transliterate_1.toLatinUz)(String(raw.name));
            }
            return exports.VoiceIntentSchema.parse(raw);
        }, 2, 800, 30000);
    }
    static async parseTextIntent(textMessage) {
        return (0, retry_1.withRetry)(async () => {
            logger_1.logger.info('Sending text message to Gemini for intent analysis');
            const raw = await askJson([
                {
                    text: `Sen do'kon yordamchisisan. Foydalanuvchining yozgan xabarini o'qib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.\n${INTENT_RULES}\nXabar matni: "${textMessage}"`,
                },
            ]);
            const parsedMoney = (0, formatters_1.parseCurrencyAndAmount)(textMessage);
            if (parsedMoney.currency === 'USD') {
                raw.currency = 'USD';
                if (parsedMoney.amount > 0) {
                    raw.amount = parsedMoney.amount;
                }
            }
            else if (raw.amount !== undefined && raw.amount !== null) {
                raw.amount = Number(Number(Math.abs(raw.amount)).toFixed(2));
            }
            if (raw.name) {
                raw.name = (0, transliterate_1.toLatinUz)(String(raw.name));
            }
            return exports.VoiceIntentSchema.parse(raw);
        }, 2, 800, 30000);
    }
}
exports.AiService = AiService;
