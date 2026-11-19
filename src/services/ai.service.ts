import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env';
import { withRetry } from '../utils/retry';
import { logger } from '../config/logger';
import { toLatinUz, normalizeForSearch } from '../utils/transliterate';
import {
  formatCurrency,
  parseCurrencyAndAmount,
  parseSmartAmount,
  reconcileInvoiceTotals,
} from '../utils/formatters';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export const DEFAULT_GENERATION_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 2048,
} as const;

export const OCR_TIMEOUT_MS = 30000;
export const OCR_MAX_OUTPUT_TOKENS = 16384;
export const INTENT_MAX_OUTPUT_TOKENS = 4096;

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
    isCrossedOut: z.boolean().optional(),
  })
  .transform((item) => {
    const rawName = toLatinUz((item.rawName || item.productName || "Noma'lum tovar").trim());
    const normalizedName = normalizeForSearch(item.normalizedName || rawName) || rawName.toLowerCase();
    const quantity = Number(item.quantity || 1);
    const isCrossedOut = Boolean(item.isCrossedOut) || /^~.*~$/.test(rawName);
    const unitPrice = isCrossedOut ? 0 : Number(Number(item.unitPrice || 0).toFixed(2));
    const computedLine = isCrossedOut ? 0 : Number((quantity * unitPrice).toFixed(2));
    const rawLine = isCrossedOut ? 0 : item.lineTotal ?? item.totalPrice ?? computedLine;
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
      ...(isCrossedOut ? { isCrossedOut: true } : {}),
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
  tableTotals: z.array(z.number()).optional().nullable(),
  hasExplicitDiscount: z.boolean().optional().nullable(),
  paymentMethod: z.enum(['CASH', 'CREDIT']).optional().nullable(),
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
Javob faqat JSON formatda bo'lsin.`;

export const COMPACT_SCANNER_PROMPT = `Sen ultra-tezkor kassa skaner apparatisansan (Raw Fast OCR & ITOGO/SKIDKA/OPLATA Mode).
DIQQAT (AVTO-ROTATSIYA): Agar rasmdagi nakladnoy 90, 180 yoki 270 daraja teskari yoxud yonbosh tushgan bo'lsa ham, uni o'zing to'g'rilab 1-qatordan oxirgi qatorgacha o'qi!
TARJIMA QILMA: Matnni Kirilldan Lotinga o'girib vaqt yo'qotma! Qog'ozda qanday yozilgan bo'lsa (Kirill bo'lsa Kirillda, Lotin bo'lsa Lotinda), o'ylab o'tirmasdan eng tez holatda birga-bir ko'chir!
QAT'IY QOIDA (ZERO-HALLUCINATION): Nakladnoydagi so'zlarni va raqamlarni aslo o'zgartirma va o'zingdan hech narsa to'qima! Har bir mahsulot nomi, soni, narxi va summasini qog'ozda qanday yozilgan bo'lsa, 100% birga-bir ko'chir. Agar biror so'z ko'rinmasa, taxmin qilmasdan '[⚠️ xira]' deb yoz.

ASOSIY KO'RSATKICHLAR:
1. supplierName: Ta'minotchi nomi.
2. paymentMethod: "CASH" (agar Наличные / Naqd bo'lsa) yoki "CREDIT" (agar Перечисление / Долг / Nasiya bo'lsa).
3. subtotalBeforeDiscount: Сумма без скидки / Сумма без переоценки (Skidkagacha summa).
4. discountPercent va discountAmount: FAQAT qog'ozda "Скидка", "Наценка", "Переоценка", "Chegirma" yoki "%" aniq yozilgan bo'lsagina yoz (va hasExplicitDiscount: true qil). Agar qog'ozda skidka yozilmagan bo'lsa, discountPercent: 0, discountAmount: 0, hasExplicitDiscount: false bo'lsin! Qatorlar yig'indisi bilan Itogo farqidan o'zingcha sun'iy skidka (masalan 1.6%) yasama!
5. printedFinalTotal va tableTotals: Итого / Всего к оплате / К оплате. Agar bitta A4 varaqda 2 ta jadval va 2 ta "Итого" bo'lsa (masalan: 1,371,040 va 772,432), tableTotals: [1371040, 772432] va printedFinalTotal: 2143472 (ularning yig'indisi) qilib qaytar!
6. QO'LYOZMA RO'YXAT REJIMI (Handwritten List Mode): Agar daftar varag'ida ustunli jadval bo'lmasdan "Mahsulot nomi - Summa" ko'rinishida yozilgan bo'lsa (masalan: "GAZVADA - 5.000", "choy chupli kichik - 3.000", "Кола 2л - 18.000", "Flavis 1.5 - 12.000", "+18 - 12.000"):
   - Tire (-) belgisining chap tomoni mahsulot nomi ("1.5", "0.5", "2л", "+18" kabi hajm/kodlarni narx deb adashtirma, nom ichida qoldir!).
   - Tire (-) belgisining o'ng tomonidagi ".000" bilan tugagan sonlar ming so'mni anglatadi ("5.000" = 5000, "12.000" = 12000).
   - Ustidan chizib o'chirilgan qatorlarni "~o'chirilgan~" deb belgilab, summasini 0 qil (jami summaga qo'shma).
7. rows: Har bir qatorni "№|Nomi|Soni va birligi|1 dona narxi|Qator jami summasi" (yoki qo'lyozmada "Nomi - Summasi") formatida qaytar.

Javobni FAQAT ixcham JSON formatda qaytar:
{"supplierName":"Roxat","paymentMethod":"CREDIT","invoiceNumber":"145","invoiceDate":"2026-11-18","currency":"UZS","rows":["1|Ярко Кетчуп|10 кор|45000|450000"],"subtotalBeforeDiscount":450000,"discountPercent":0,"discountAmount":0,"hasExplicitDiscount":false,"tableTotals":[450000],"printedFinalTotal":450000}`;

function getCandidateModels(explicitModels?: string[]): string[] {
  const envModel = process.env.GEMINI_MODEL?.trim();
  const base =
    explicitModels && explicitModels.length > 0
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

function repairCommonJsonGlitches(input: string): string {
  // 1. Escape unescaped inner quotes inside compact scanner row strings like: "1|Печенье "Рохат"|10|1000|10000"
  let s = input
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*")(.+)("(?:\s*\])?(?:,\s*|\s*))$/);
      if (!m) return line;
      const [, prefix, inner, suffix] = m;
      if ((inner.includes('|') || inner.includes(' - ')) && /(?<!\\)"/.test(inner)) {
        const fixedInner = inner.replace(/(?<!\\)"/g, '\\"');
        return `${prefix}${fixedInner}${suffix}`;
      }
      return line;
    })
    .join('\n');

  // 2. Remove trailing commas before ] or }
  s = s.replace(/,\s*([\]}])/g, '$1');

  return s;
}

export function extractCleanJson(rawText: string, finishReason?: string): any {
  const trimmed = (rawText || '').trim();
  if (!trimmed) throw new Error('Empty response from Gemini');
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Attempt 1: Direct JSON.parse
  try {
    return JSON.parse(stripped);
  } catch {}

  // Attempt 2: Slice from first '{' to last '}'
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = stripped.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch {
      try {
        return JSON.parse(repairCommonJsonGlitches(sliced));
      } catch {}
    }
  }

  // Attempt 3: Sanitize full stripped text and auto-close if only final closing delimiters were cut off
  if (start !== -1) {
    const candidate = repairCommonJsonGlitches(stripped.slice(start));
    try {
      return JSON.parse(candidate);
    } catch {}

    // If printedFinalTotal or subtotalBeforeDiscount is already present and only closing '}' / ']}' is missing
    if (/printedFinalTotal|subtotalBeforeDiscount|"intent"\s*:/i.test(candidate)) {
      for (const suffix of ['}', '"}', '"]}', ']}']) {
        try {
          return JSON.parse(candidate.replace(/,\s*$/, '') + suffix);
        } catch {}
      }
    }
  }

  throw new Error(
    finishReason === 'MAX_TOKENS'
      ? 'Invalid JSON response from Gemini (truncated by MAX_TOKENS)'
      : 'Invalid JSON response from Gemini'
  );
}

/**
 * 1-MUAMMO: 30 Soniyalik Timeout (`OCR_TIMEOUT_MS = 30000`) va Avtomatik 1 marta Qayta Urinish (`retryOnceOnTimeout`).
 */
export async function retryOnceOnTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number = OCR_TIMEOUT_MS,
  label = 'Gemini OCR'
): Promise<T> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`${label} request timed out (${Math.round(timeoutMs / 1000)}s)`)),
            timeoutMs
          );
        }),
      ]);
    } catch (error: any) {
      lastErr = error;
      const isTimeoutOrTransient =
        error?.status === 503 ||
        /timed?\s*out|timeout|503|fetch failed|ECONNRESET|ETIMEDOUT|ABORT_ERR|network/i.test(
          error?.message || ''
        );
      if (isTimeoutOrTransient && attempt < 2) {
        logger.warn(`${label} delayed on attempt 1 (${error?.message?.slice(0, 80)}), auto-retrying once...`);
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function generateContentWithFallback(
  aiCall: (modelName: string) => Promise<any>,
  models?: string[],
  timeoutMs: number = OCR_TIMEOUT_MS
) {
  const candidateModels = getCandidateModels(models);
  let lastError: any = null;
  for (const model of candidateModels) {
    try {
      return await retryOnceOnTimeout(() => aiCall(model), timeoutMs, `Model ${model}`);
    } catch (error: any) {
      lastError = error;
      logger.warn(`Model ${model} failed: ${error?.message?.slice(0, 120)}`);
    }
  }
  throw lastError;
}

const askJson = async (
  parts: any[],
  maxOutputTokens = OCR_MAX_OUTPUT_TOKENS,
  models?: string[],
  timeoutMs: number = OCR_TIMEOUT_MS
) => {
  // Ensure thinking models (e.g. gemini-3-flash-preview) always have enough budget for both thoughts + JSON output
  const effectiveMaxOutputTokens = Math.max(Number(maxOutputTokens) || 0, INTENT_MAX_OUTPUT_TOKENS);
  return generateContentWithFallback(
    async (model) => {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          temperature: DEFAULT_GENERATION_CONFIG.temperature,
          maxOutputTokens: effectiveMaxOutputTokens,
        },
      });
      if (!res.text) throw new Error('Empty response from Gemini');
      const finishReason = res.candidates?.[0]?.finishReason;
      return extractCleanJson(res.text, finishReason);
    },
    models,
    timeoutMs
  );
};

/**
 * 4-MUAMMO: Qo'lyozma Ro'yxat Qatorini Tahlil Qiluvchi (`parseHandwrittenReceiptLine`).
 * Format: "GAZVADA - 5.000", "choy chupli kichik - 3.000", "Кола 2л - 18.000",
 *         "Flavis 1.5 - 12.000", "+18 - 12.000", "~Pepsi 1.5 - 15.000~"
 * - Tire (-) dan oldingi qism ("Flavis 1.5", "+18", "Кола 2л") to'liq mahsulot nomi sifatida olinadi.
 * - Tire (-) dan keyingi qism ("5.000", "12.000") `parseSmartAmount` orqali 5000, 12000 so'm deb o'qiladi.
 * - Ustidan chizilgan (~...~) qatorlar isCrossedOut: true va summasi 0 bo'ladi.
 */
export function parseHandwrittenReceiptLine(
  rawLine: string,
  defaultCurrency: 'UZS' | 'USD' = 'UZS'
): ParsedInvoiceItem | null {
  if (!rawLine || typeof rawLine !== 'string') return null;
  let cleaned = rawLine.trim();
  if (!cleaned) return null;

  const isCrossedOut =
    /^~+.*~+$/.test(cleaned) ||
    /~~.*~~/.test(cleaned) ||
    /\[?\s*o['`’]?chirilgan\s*\]?/i.test(cleaned);

  const unwrapped = cleaned.replace(/^~+|~+$/g, '').trim();
  // Match the LAST " - " / " — " / " – " followed by a price expression
  const dashMatch = unwrapped.match(/^(.*?)\s+[-–—]\s+([~$\d][\d\s.,$'so`’mUZSusd~]*)$/i);
  if (!dashMatch) return null;

  let rawNamePart = dashMatch[1].replace(/^\d+[.)]\s*/, '').trim();
  const rawPricePart = dashMatch[2].replace(/~/g, '').trim();
  if (!rawNamePart || !/\d/.test(rawPricePart)) return null;

  const amount = isCrossedOut ? 0 : parseSmartAmount(rawPricePart);
  const parsedCur = parseCurrencyAndAmount(rawPricePart).currency;
  const itemCurrency: 'UZS' | 'USD' = parsedCur === 'USD' || /\$|usd|usdt/i.test(rawPricePart) ? 'USD' : defaultCurrency;

  const latinName = toLatinUz(rawNamePart);
  const displayName = isCrossedOut ? `~${latinName.replace(/~/g, '')}~` : latinName;
  const normalizedName = normalizeForSearch(latinName) || latinName.toLowerCase();

  return {
    rawName: displayName,
    normalizedName,
    productName: displayName,
    quantity: 1,
    unit: 'dona',
    unitPrice: Number(amount.toFixed(2)),
    lineTotal: Number(amount.toFixed(2)),
    totalPrice: Number(amount.toFixed(2)),
    currency: itemCurrency,
    ...(isCrossedOut ? { isCrossedOut: true } : {}),
  };
}

/**
 * 1-MUAMMO & 4-MUAMMO: Ultra-fast (<0.001s) Node.js background parser & Cyrillic->Latin converter
 * for both compact scanner `rows` ("№|Nomi|Soni|Narxi|Summasi") and handwritten receipt rows ("GAZVADA - 5.000").
 */
export function parseCompactScannerRows(
  rows: string[],
  defaultCurrency: 'UZS' | 'USD' = 'UZS'
): ParsedInvoiceItem[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const items: ParsedInvoiceItem[] = [];

  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== 'string') continue;
    const trimmed = rawRow.trim();
    if (!trimmed) continue;

    // 1. Check if row is a single-column or 2-column Handwritten List line ("GAZVADA - 5.000", "Flavis 1.5 - 12.000")
    if (!trimmed.includes('|')) {
      const hwItem = parseHandwrittenReceiptLine(trimmed, defaultCurrency);
      if (hwItem) {
        items.push(hwItem);
      }
      continue;
    }

    const cols = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cols.length < 2) {
      const hwItem = parseHandwrittenReceiptLine(cols[0] || trimmed, defaultCurrency);
      if (hwItem) items.push(hwItem);
      continue;
    }

    // Check if 2-col row like "1 | GAZVADA - 5.000" or "GAZVADA | 5.000"
    if (cols.length === 2) {
      if (/^\d+\.?$/.test(cols[0])) {
        const hwItem = parseHandwrittenReceiptLine(cols[1], defaultCurrency);
        if (hwItem) {
          items.push(hwItem);
          continue;
        }
      }
      const isCrossed = /^~+.*~+$/.test(cols[0]) || /^~+.*~+$/.test(cols[1]) || /o['`’]?chirilgan/i.test(trimmed);
      const rawName = toLatinUz(cols[0].replace(/^~+|~+$/g, '').trim()) || "Noma'lum tovar";
      const displayName = isCrossed ? `~${rawName}~` : rawName;
      const amt = isCrossed ? 0 : parseSmartAmount(cols[1]);
      const itemCurrency: 'UZS' | 'USD' =
        parseCurrencyAndAmount(cols[1]).currency === 'USD' || /\$/i.test(cols[1]) ? 'USD' : defaultCurrency;
      items.push({
        rawName: displayName,
        normalizedName: normalizeForSearch(rawName) || rawName.toLowerCase(),
        productName: displayName,
        quantity: 1,
        unit: 'dona',
        unitPrice: Number(amt.toFixed(2)),
        lineTotal: Number(amt.toFixed(2)),
        totalPrice: Number(amt.toFixed(2)),
        currency: itemCurrency,
        ...(isCrossed ? { isCrossedOut: true } : {}),
      });
      continue;
    }

    const isCrossedOut = /^~+.*~+$/.test(trimmed) || /~~.*~~/.test(trimmed);
    const firstIsIndex = /^\d+\.?$/.test(cols[0]) && cols.length >= 4;
    const rawNameCol = (firstIsIndex ? cols[1] : cols[0]) || "Noma'lum tovar";
    const qtyCol = (firstIsIndex ? cols[2] : cols[1]) || '1 dona';
    const priceCol = (firstIsIndex ? cols[3] : cols[2]) || '0';
    const totalCol = (firstIsIndex ? cols[4] : cols[3]) || '';

    const qtyMatch = qtyCol.match(/(\d+(?:[.,]\d+)?)\s*(.*)/);
    const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) || 1 : 1;
    const unitRaw = (qtyMatch?.[2] || '').replace(/[xх*]/gi, '').trim() || 'dona';
    const unit = toLatinUz(unitRaw) || 'dona';

    const parsedPriceCur = parseCurrencyAndAmount(priceCol);
    const itemCurrency: 'UZS' | 'USD' =
      parsedPriceCur.currency === 'USD' || /\$/i.test(priceCol) || /\$/i.test(totalCol) ? 'USD' : defaultCurrency;
    const unitPrice = isCrossedOut ? 0 : Number(parseSmartAmount(priceCol).toFixed(2));
    const parsedTotal = isCrossedOut
      ? 0
      : totalCol
      ? parseSmartAmount(totalCol)
      : Number((quantity * unitPrice).toFixed(2));
    const lineTotal = isCrossedOut ? 0 : Number((parsedTotal > 0 ? parsedTotal : quantity * unitPrice).toFixed(2));
    const cleanRawName = toLatinUz(rawNameCol.replace(/^~+|~+$/g, '').trim());
    const displayName = isCrossedOut ? `~${cleanRawName}~` : cleanRawName;
    const normalizedName = normalizeForSearch(cleanRawName) || cleanRawName.toLowerCase();

    items.push({
      rawName: displayName,
      normalizedName,
      productName: displayName,
      quantity,
      unit,
      unitPrice,
      lineTotal,
      totalPrice: lineTotal,
      currency: itemCurrency,
      ...(isCrossedOut ? { isCrossedOut: true } : {}),
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

    if (!line.includes('|')) {
      const hwItem = parseHandwrittenReceiptLine(line, defaultCurrency);
      if (hwItem) extracted.push(hwItem);
      continue;
    }

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

    const parsedItems = parseCompactScannerRows([cols.join('|')], defaultCurrency);
    if (parsedItems.length > 0) {
      extracted.push(parsedItems[0]);
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
  const subtotalBeforeDiscount = parseSmartAmount(
    raw.subtotalBeforeDiscount ?? raw.rawTotal ?? raw.originalAmount ?? raw.grossTotal ?? raw.total_amount ?? 0
  );
  const tableTotals: number[] | null = Array.isArray(raw.tableTotals)
    ? raw.tableTotals.map((t: any) => parseSmartAmount(t)).filter((n: number) => n > 0)
    : null;
  const printedFinalTotal = parseSmartAmount(
    raw.printedFinalTotal ?? raw.finalTotal ?? raw.netTotal ?? subtotalBeforeDiscount ?? itemsSum ?? 0
  );
  const discountPercent = raw.discountPercent ?? null;
  const discountAmountInput = raw.discountLabel ?? raw.discountAmount ?? raw.discount ?? 0;

  // 2-MUAMMO: Strict Discount Guard & Multi-Table A4 reconciliation
  const reconciled = reconcileInvoiceTotals({
    rows: items,
    itemsSum,
    subtotalBeforeDiscount,
    discountPercent,
    discountAmount: discountAmountInput,
    printedFinalTotal,
    tableTotals,
    hasExplicitDiscount: raw.hasExplicitDiscount,
  });

  const verbatimText =
    items.length > 0
      ? buildVerbatimTableText(items, currency)
      : toLatinUz(String(raw.verbatimText || raw.table_text || '').trim());

  const supplierName = toLatinUz((caption || raw.supplierName || raw.supplier || "Noma'lum").trim());
  const invoiceNo = raw.invoiceNumber ?? raw.invoiceNo ?? null;
  const discountLabel =
    reconciled.discountAmount > 0
      ? raw.discountLabel || (reconciled.discountPercent > 0 ? `${reconciled.discountPercent}%` : null)
      : null;
  const paymentMethod: 'CASH' | 'CREDIT' =
    raw.paymentMethod === 'CASH' || raw.isCashOverride ? 'CASH' : 'CREDIT';

  return InvoiceSchema.parse({
    ...raw,
    currency,
    paymentMethod,
    isCashOverride: raw.isCashOverride ?? paymentMethod === 'CASH',
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
    tableTotals,
    hasExplicitDiscount: reconciled.discountAmount > 0,
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
  static readonly OCR_TIMEOUT_MS = OCR_TIMEOUT_MS;
  static readonly OCR_MAX_OUTPUT_TOKENS = OCR_MAX_OUTPUT_TOKENS;

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
        logger.info('Sending invoice image to Gemini for Single-Pass Compact Scanner OCR (30s timeout)');
        const promptText = caption
          ? `${COMPACT_SCANNER_PROMPT}\nFoydalanuvchi izohi (ustuvor ta'minotchi nomi): "${caption}"`
          : COMPACT_SCANNER_PROMPT;
        const parsed = await askJson(
          [
            { text: promptText },
            { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
          ],
          OCR_MAX_OUTPUT_TOKENS,
          undefined,
          OCR_TIMEOUT_MS
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
          OCR_MAX_OUTPUT_TOKENS
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
