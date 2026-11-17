import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env';
import { withRetry } from '../utils/retry';
import { logger } from '../config/logger';
import { toLatinUz, normalizeForSearch } from '../utils/transliterate';
import {
  formatCurrency,
  parseCurrencyAndAmount,
  reconcileInvoiceTotals,
} from '../utils/formatters';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export const DEFAULT_GENERATION_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 2048,
} as const;

export const InvoiceItemSchema = z
  .object({
    rawName: z.string().optional(),
    normalizedName: z.string().optional(),
    productName: z.string().optional(),
    quantity: z.number().default(1),
    unit: z.string().optional().default('dona'),
    unitPrice: z.number().default(0),
    lineTotal: z.number().optional(),
    totalPrice: z.number().optional(),
    currency: z.enum(['UZS', 'USD']).optional().default('UZS'),
  })
  .transform((item) => {
    const rawName = toLatinUz((item.rawName || item.productName || "Noma'lum tovar").trim());
    const normalizedName = normalizeForSearch(item.normalizedName || rawName) || rawName.toLowerCase();
    const quantity = Number(item.quantity || 1);
    const unitPrice = Number(Number(item.unitPrice || 0).toFixed(2));
    const computedLine = Number((quantity * unitPrice).toFixed(2));
    const rawLine = item.lineTotal ?? item.totalPrice ?? computedLine;
    const lineTotal = Number(Number(rawLine).toFixed(2));
    const unit = toLatinUz(item.unit || 'dona').trim() || 'dona';
    return {
      rawName,
      normalizedName,
      productName: rawName,
      quantity,
      unit,
      unitPrice,
      lineTotal,
      totalPrice: lineTotal,
      currency: item.currency || ('UZS' as const),
    };
  });

export type ParsedInvoiceItem = z.infer<typeof InvoiceItemSchema>;

export const InvoiceSchema = z.object({
  total_amount: z.number().default(0),
  rawTotal: z.number().optional().nullable(),
  subtotalBeforeDiscount: z.number().optional().nullable(),
  discountPercent: z.number().optional().nullable(),
  discount: z.number().default(0),
  finalTotal: z.number().optional().nullable(),
  printedFinalTotal: z.number().optional().nullable(),
  currency: z.enum(['UZS', 'USD']).default('UZS'),
  verbatimText: z.string().default(''),
  table_text: z.string().default(''),
  supplier: z.string().optional().nullable(),
  invoiceNo: z.string().optional().nullable(),
  invoiceNumber: z.string().optional().nullable(),
  invoiceDate: z.string().optional().nullable(),
  supplierName: z.string().optional().nullable(),
  grossTotal: z.number().optional().nullable(),
  discountAmount: z.number().optional().nullable(),
  netTotal: z.number().optional().nullable(),
  itemsCount: z.number().optional().nullable(),
  sampleItems: z.array(z.string()).optional().nullable(),
  rows: z.array(z.string()).optional().nullable(),
  items: z.any().optional().nullable(),
  isCaptionOverride: z.boolean().optional(),
  isCashOverride: z.boolean().optional(),
  exactSupplierId: z.string().optional().nullable(),
  discountLabel: z.string().optional().nullable(),
  imageHash: z.string().optional().nullable(),
  contentFingerprint: z.string().optional().nullable(),
});

export const VoiceIntentSchema = z.object({
  intent: z.enum([
    'ADD_EXPENSE',
    'ADD_SUPPLIER_TX',
    'ADD_CUSTOMER_DEBT',
    'ADD_CASH_TX',
    'SEARCH_PRODUCT',
    'GET_DEBT_INFO',
    'GENERAL_CHAT',
    'UNKNOWN',
  ]),
  txType: z.enum(['INCOMING_GOODS', 'PAYMENT']).optional().nullable(),
  amount: z.number().optional().nullable(),
  currency: z.enum(['UZS', 'USD']).nullable().optional().default('UZS'),
  name: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  comment: z.string().optional().nullable(),
  replyText: z.string().optional().nullable(),
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

export const COMPACT_SCANNER_PROMPT = `Sen ultra-tezkor kassa skaner apparatisansan (2-3s Single-Pass Scanner Mode).
DIQQAT: Agar rasmdagi nakladnoy teskari (180 daraja oyog'i osmondan) yoki yonbosh tushgan bo'lsa ham, uni o'zing to'g'rilab o'qi! Barcha qatorlarni 1-qatordan oxirgi qatorgacha hech birini qoldirmasdan o'qi va barcha Kirill harflarini darhol O'zbek Lotin alifbosiga (masalan: 'Ярко Кетчуп' -> 'Yarko Ketchup') o'girib qaytar!
Agar rasmda matn ko'rinmasa yoki bo'sh bo'lsa, rows: [] va 0 summalar bilan bir qatorli ixcham JSON qaytar.

QOIDA:
1. Uzun jadval yozma! Faqat "rows" massivida har bir qatorni "№|Lotincha Nomi|Soni va birligi|1 dona narxi|Qator jami summasi" formatida qaytar.
2. Eng pastdagi skidkagacha bo'lgan jami summani (subtotalBeforeDiscount), skidka foizini (discountPercent), skidka summasini (discountAmount) va qog'ozda yozilgan yakuniy summani (printedFinalTotal) yoz.
3. Agar $, USD, USDT, у.е. bo'lsa yoki narxlar kichik kasr sonlarda (1.25, 102.17) bo'lsa -> currency="USD", aks holda "UZS". Sentlarni aslo yaxlitlama!

Javobni FAQAT ixcham (minifikatsiya qilingan) JSON formatda qaytar:
{"supplierName":"Milter","invoiceNumber":"145","invoiceDate":"2026-11-17","currency":"UZS","rows":["1|Yarko Ketchup|10 kor|45000|450000"],"subtotalBeforeDiscount":450000,"discountPercent":0,"discountAmount":0,"printedFinalTotal":450000}`;

function getCandidateModels(explicitModels?: string[]): string[] {
  const envModel = process.env.GEMINI_MODEL?.trim();
  const base =
    explicitModels && explicitModels.length > 0
      ? explicitModels
      : [
          'gemini-3-flash-preview',
          'gemini-flash-lite-latest',
          'gemini-3.8-flash',
          'gemini-flash-latest',
          'gemini-3.7-flash',
        ];
  return Array.from(new Set([...(envModel ? [envModel] : []), ...base]));
}

function extractCleanJson(rawText: string): any {
  const trimmed = (rawText || '').trim();
  if (!trimmed) throw new Error('Empty response from Gemini');
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1));
    }
    throw new Error('Invalid JSON response from Gemini');
  }
}

export async function generateContentWithFallback(
  aiCall: (modelName: string) => Promise<any>,
  models?: string[]
) {
  const candidateModels = getCandidateModels(models);
  let lastError: any = null;
  for (const model of candidateModels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          aiCall(model),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`Model ${model} request timed out (15s)`)), 15000);
          }),
        ]);
      } catch (error: any) {
        lastError = error;
        const isTransient =
          error?.status === 503 || /503|fetch failed|ECONNRESET/i.test(error?.message || '');
        if (isTransient && attempt < 2) {
          logger.warn(`Model ${model} busy (${error?.message?.slice(0, 60)}), retrying...`);
          await new Promise((res) => setTimeout(res, 500));
          continue;
        }
        logger.warn(`Model ${model} failed: ${error?.message?.slice(0, 120)}`);
        break;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  throw lastError;
}

const askJson = async (
  parts: any[],
  maxOutputTokens = DEFAULT_GENERATION_CONFIG.maxOutputTokens,
  models?: string[]
) => {
  return generateContentWithFallback(async (model) => {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        temperature: DEFAULT_GENERATION_CONFIG.temperature,
        maxOutputTokens,
      },
    });
    if (!res.text) throw new Error('Empty response from Gemini');
    return extractCleanJson(res.text);
  }, models);
};

/**
 * MODUL 1.3 & MODUL 3: Ultra-fast (<0.001s) Node.js parser for compact scanner `rows` ("№|Nomi|Soni|Narxi|Summasi").
 * Automatically converts all Cyrillic item names and units to Uzbek Latin (`toLatinUz`).
 */
export function parseCompactScannerRows(
  rows: string[],
  defaultCurrency: 'UZS' | 'USD' = 'UZS'
): ParsedInvoiceItem[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const items: ParsedInvoiceItem[] = [];

  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== 'string') continue;
    const cols = rawRow
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cols.length < 2) continue;

    const firstIsIndex = /^\d+\.?$/.test(cols[0]) && cols.length >= 4;
    const rawName = (firstIsIndex ? cols[1] : cols[0]) || "Noma'lum tovar";
    const qtyCol = (firstIsIndex ? cols[2] : cols[1]) || '1 dona';
    const priceCol = (firstIsIndex ? cols[3] : cols[2]) || '0';
    const totalCol = (firstIsIndex ? cols[4] : cols[3]) || '';

    const qtyMatch = qtyCol.match(/(\d+(?:[.,]\d+)?)\s*(.*)/);
    const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) || 1 : 1;
    const unitRaw = (qtyMatch?.[2] || '').replace(/[xх*]/gi, '').trim() || 'dona';
    const unit = toLatinUz(unitRaw) || 'dona';

    const parsedPrice = parseCurrencyAndAmount(priceCol);
    const itemCurrency: 'UZS' | 'USD' =
      parsedPrice.currency === 'USD' || /\$/i.test(priceCol) || /\$/i.test(totalCol) ? 'USD' : defaultCurrency;
    const unitPrice = Number(parsedPrice.amount.toFixed(2));
    const parsedTotal = totalCol ? parseCurrencyAndAmount(totalCol).amount : Number((quantity * unitPrice).toFixed(2));
    const lineTotal = Number((parsedTotal > 0 ? parsedTotal : quantity * unitPrice).toFixed(2));
    const cleanRawName = toLatinUz(rawName.trim());
    const normalizedName = normalizeForSearch(cleanRawName) || cleanRawName.toLowerCase();

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

export function parseVerbatimTableToItems(
  tableText: string,
  defaultCurrency: 'UZS' | 'USD' = 'UZS'
): ParsedInvoiceItem[] {
  if (!tableText || !tableText.trim()) return [];
  const lines = tableText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const extracted: ParsedInvoiceItem[] = [];

  for (const line of lines) {
    if (/^\|?[\s\-:|]+\|?$/.test(line)) continue;

    if (line.includes('|')) {
      const cols = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cols.length < 2) continue;

      const joinedLower = cols.join(' ').toLowerCase();
      if (
        (joinedLower.includes('mahsulot') || joinedLower.includes('tovar') || joinedLower.includes('наименование')) &&
        (joinedLower.includes('narx') || joinedLower.includes('soni') || joinedLower.includes('цена') || joinedLower.includes('сумма'))
      ) {
        continue;
      }

      const firstIsIndex = /^\d+\.?$/.test(cols[0]) && cols.length >= 4;
      const nameCol = toLatinUz(firstIsIndex ? cols[1] : cols[0]);
      const qtyCol = firstIsIndex ? cols[2] : cols[1] || '1';
      const priceCol = firstIsIndex ? cols[3] : cols[2] || '0';
      const totalCol = firstIsIndex ? cols[4] : cols[3] || '';

      const qtyMatch = qtyCol.match(/(\d+(?:[.,]\d+)?)\s*(.*)/);
      const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) || 1 : 1;
      const unit = toLatinUz((qtyMatch?.[2] || '').replace(/[xх*]/gi, '').trim()) || 'dona';

      const parsedPrice = parseCurrencyAndAmount(priceCol);
      const itemCurrency: 'UZS' | 'USD' =
        parsedPrice.currency === 'USD' || /\$/i.test(priceCol) || /\$/i.test(totalCol) ? 'USD' : defaultCurrency;
      const unitPrice = parsedPrice.amount;
      const parsedTotal = totalCol ? parseCurrencyAndAmount(totalCol).amount : Number((quantity * unitPrice).toFixed(2));
      const lineTotal = parsedTotal > 0 ? parsedTotal : Number((quantity * unitPrice).toFixed(2));

      extracted.push(
        InvoiceItemSchema.parse({
          rawName: nameCol,
          normalizedName: normalizeForSearch(nameCol),
          quantity,
          unit,
          unitPrice,
          lineTotal,
          currency: itemCurrency,
        })
      );
    }
  }

  return extracted;
}

export function buildVerbatimTableText(items: ParsedInvoiceItem[], currency: 'UZS' | 'USD' = 'UZS'): string {
  if (!items || items.length === 0) return '';
  const header = `| № | Mahsulot nomi | Soni | 1 dona narxi | Jami summasi |\n|---|---|---|---|---|`;
  const rows = items.map((it, idx) => {
    const cur = it.currency || currency;
    const nameText = toLatinUz(it.rawName || it.productName || '');
    const qtyText = `${it.quantity} ${toLatinUz(it.unit || 'dona')}`.trim();
    const priceText = formatCurrency(it.unitPrice, cur);
    const totalText = formatCurrency(it.lineTotal ?? it.totalPrice, cur);
    return `| ${idx + 1} | ${nameText} | ${qtyText} | ${priceText} | ${totalText} |`;
  });
  return [header, ...rows].join('\n');
}

export function normalizeVerbatimInvoice(raw: any, caption?: string): z.infer<typeof InvoiceSchema> {
  const parsedCaptionCurrency = caption ? parseCurrencyAndAmount(caption) : null;
  let currency: 'UZS' | 'USD' =
    raw.currency === 'USD' ||
    parsedCaptionCurrency?.currency === 'USD' ||
    /\$|usd|usdt|у\.е/i.test(String(raw.verbatimText || raw.table_text || (raw.rows || []).join(' ')))
      ? 'USD'
      : 'UZS';

  let items: ParsedInvoiceItem[] = [];
  if (Array.isArray(raw.rows) && raw.rows.length > 0) {
    items = parseCompactScannerRows(raw.rows, currency);
  } else if (Array.isArray(raw.items) && raw.items.length > 0) {
    items = raw.items.map((it: any) =>
      InvoiceItemSchema.parse({
        ...it,
        currency: it.currency === 'USD' ? 'USD' : currency,
      })
    );
  } else if (raw.verbatimText || raw.table_text) {
    items = parseVerbatimTableToItems(String(raw.verbatimText || raw.table_text), currency);
  }

  if (items.some((i) => i.currency === 'USD')) {
    currency = 'USD';
  }

  const itemsSum = items.reduce((acc, it) => acc + Number(it.lineTotal || it.totalPrice || 0), 0);
  const subtotalBeforeDiscount = Number(
    raw.subtotalBeforeDiscount ?? raw.rawTotal ?? raw.originalAmount ?? raw.grossTotal ?? raw.total_amount ?? 0
  );
  const printedFinalTotal = Number(
    raw.printedFinalTotal ?? raw.finalTotal ?? raw.netTotal ?? subtotalBeforeDiscount ?? itemsSum ?? 0
  );
  const discountPercent = raw.discountPercent ?? null;
  const discountAmountInput = raw.discountLabel ?? raw.discountAmount ?? raw.discount ?? 0;

  // Double-Discount Guard reconciliation
  const reconciled = reconcileInvoiceTotals({
    rows: items,
    itemsSum,
    subtotalBeforeDiscount,
    discountPercent,
    discountAmount: discountAmountInput,
    printedFinalTotal,
  });

  const verbatimText =
    items.length > 0
      ? buildVerbatimTableText(items, currency)
      : toLatinUz(String(raw.verbatimText || raw.table_text || '').trim());

  const supplierName = toLatinUz((caption || raw.supplierName || raw.supplier || "Noma'lum").trim());
  const invoiceNo = raw.invoiceNumber ?? raw.invoiceNo ?? null;
  const discountLabel =
    raw.discountLabel || (reconciled.discountPercent > 0 ? `${reconciled.discountPercent}%` : null);

  return InvoiceSchema.parse({
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
    sampleItems: items.map(
      (it) =>
        `${it.rawName} | ${it.quantity} ${it.unit || 'dona'} x ${formatCurrency(it.unitPrice, it.currency || currency)} = ${formatCurrency(it.lineTotal, it.currency || currency)}`
    ),
  });
}

export class AiService {
  static readonly DEFAULT_GENERATION_CONFIG = DEFAULT_GENERATION_CONFIG;

  static async parseInvoiceImage(
    imageBuffer: Buffer,
    _mimeType = 'image/jpeg',
    caption?: string
  ): Promise<z.infer<typeof InvoiceSchema>> {
    if (!imageBuffer || imageBuffer.byteLength === 0) {
      throw new Error("Nakladnoy rasm fayli bo'sh");
    }
    return withRetry(
      async () => {
        logger.info('Sending invoice image to Gemini for Single-Pass Compact Scanner OCR');
        const parsed = await askJson(
          [
            { text: COMPACT_SCANNER_PROMPT },
            { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
          ],
          DEFAULT_GENERATION_CONFIG.maxOutputTokens
        );
        return normalizeVerbatimInvoice(parsed, caption);
      },
      2,
      800,
      90000
    );
  }

  static async parseInvoiceText(invoiceText: string): Promise<z.infer<typeof InvoiceSchema>> {
    return withRetry(
      async () => {
        const prompt = `${COMPACT_SCANNER_PROMPT}\n\nFoydalanuvchi quyidagi nakladnoy matnini yubordi. Barcha qatorlarni rows massiviga va yakuniy raqamlarga ajrat:\nMatn: "${invoiceText}"`;

        const parsed = await askJson(
          [{ text: prompt }],
          DEFAULT_GENERATION_CONFIG.maxOutputTokens
        );
        return normalizeVerbatimInvoice(parsed);
      },
      2,
      800,
      30000
    );
  }

  static async parseVoiceNote(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<z.infer<typeof VoiceIntentSchema>> {
    return withRetry(
      async () => {
        logger.info('Sending voice note to Gemini for analysis');
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
          raw.name = toLatinUz(String(raw.name));
        }
        return VoiceIntentSchema.parse(raw);
      },
      2,
      800,
      30000
    );
  }

  static async parseTextIntent(textMessage: string): Promise<z.infer<typeof VoiceIntentSchema>> {
    return withRetry(
      async () => {
        logger.info('Sending text message to Gemini for intent analysis');
        const raw = await askJson([
          {
            text: `Sen do'kon yordamchisisan. Foydalanuvchining yozgan xabarini o'qib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.\n${INTENT_RULES}\nXabar matni: "${textMessage}"`,
          },
        ]);

        const parsedMoney = parseCurrencyAndAmount(textMessage);
        if (parsedMoney.currency === 'USD') {
          raw.currency = 'USD';
          if (parsedMoney.amount > 0) {
            raw.amount = parsedMoney.amount;
          }
        } else if (raw.amount !== undefined && raw.amount !== null) {
          raw.amount = Number(Number(Math.abs(raw.amount)).toFixed(2));
        }
        if (raw.name) {
          raw.name = toLatinUz(String(raw.name));
        }

        return VoiceIntentSchema.parse(raw);
      },
      2,
      800,
      30000
    );
  }
}
