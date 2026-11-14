import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env';
import { withRetry } from '../utils/retry';
import { logger } from '../config/logger';
import { TranslitService } from './translit.service';
import {
  formatCurrency,
  parseCurrencyAndAmount,
  reconcileInvoiceTotals,
} from '../utils/formatters';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

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
    const rawName = (item.rawName || item.productName || "Noma'lum tovar").trim();
    const normalizedName =
      (item.normalizedName || TranslitService.toLatin(rawName).toLowerCase().trim()) || rawName.toLowerCase();
    const quantity = Number(item.quantity || 1);
    const unitPrice = Number(Number(item.unitPrice || 0).toFixed(2));
    const computedLine = Number((quantity * unitPrice).toFixed(2));
    const rawLine = item.lineTotal ?? item.totalPrice ?? computedLine;
    const lineTotal = Number(Number(rawLine).toFixed(2));
    return {
      rawName,
      normalizedName,
      productName: rawName,
      quantity,
      unit: item.unit || 'dona',
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
  * Agar "Yuk keldi / yuk chiqdi / yuk oldik" yoki musbat amaliyot bo'lsa (masalan: "+1 000 000 Milter", "Milter +500 ming", "Milterdan 500 minglik yuk keldi", "Milterdan 102.17$ lik yuk keldi") -> txType="INCOMING_GOODS".
  * Agar "Pul berdik / to'ladik / to'lov qildim / qarzdan ayir / ayirdim" yoki manfiy amaliyot bo'lsa (masalan: "-1.000.000 Milterdan", "Milter -1.000.000", "-500 ming Akmal", "Milterdan 1 mln to'lov", "Azamatdan 500 ming ayir", "Milterga $50.17 berdim") -> txType="PAYMENT". Qarzdan ayirish amali!
  MUHIM: "-1.000.000 Milterdan" yoki "Milter -1 mln" kabi yozuvlar qarz so'rash EMAS, balki qarzdan ayirish (to'lov / PAYMENT) amaliyotidir!
- ADD_CASH_TX: Naqd xarid yoki naqd savdo (masalan: "Naqdga 500 minglik yuk oldim", "Naqd Nehir 200 ming"). MUHIM: Agar matnda "naqd" so'zi bo'lsa, uni albatta shu turkumga kirit.
- ADD_CUSTOMER_DEBT: Nasiyaga mol berish/mijoz qarzi (masalan: "Rustam 50 ming so'mlik narsa oldi, yozib qo'y", "Akmal nasiya 100 ming").
- SEARCH_PRODUCT: Tovarni qidirish (masalan: "Kola narxi qancha?", "Marvari bormi?").
- GET_DEBT_INFO: FAQAT va FAQAT qarz miqdorini SO'RASH (masalan: "Milterdan qancha qarzim bor?", "Milter qarzi qancha?", "Akmalning qarzi qancha bo'ldi?"). Agar xabarda aniq amaliyot summasi yoki -/+ belgisi bo'lsa (masalan "-1 000 000"), bu qarz so'rash EMAS!
- GENERAL_CHAT: Yuqoridagilardan tashqari erkin savdo, maslahat, yordam so'ralganda. Bunday holatda "replyText" ga o'zbek tilida to'liq maslahatchi sifatida professional javobni yoz.
- UNKNOWN: Agar butunlay tushunarsiz yoki aloqasiz bo'lsa.
VALYUTA VA SENT QOIDASI:
- Agar xabarda $, USD, USDT, dollar, doll, dolar, ye, у.е., долл, sent, cent so'zlari/belgilari bo'lsa -> currency="USD".
- "102 dollar 17 sent", "102.17$", "102,17 USDT" kabi summalarda kasr qismini (sentlarni, masalan 102.17) ASLO yaxlitlama, aynan 102.17 qilib qaytar!
Summalarni (amount) doim MUSBAT (Math.abs) qilib raqamda yoz. Valyutani (currency) UZS yoki USD qilib belgil.
Ism/nomni (name) kirit (ta'minotchi, mijoz yoki tovar nomi). Javob faqat JSON formatda bo'lsin.`;

const COMPACT_SCANNER_PROMPT = `Sen ultra-tezkor kassa skaner apparatisansan (<=3s Single-Pass Scanner Mode).
QOIDA:
1. Nakladnoydagi BARCHA qatorlarni 1-qatordan oxirgi qatorgacha hech bir so'zni qisqartirmasdan o'qi.
2. Uzun jadval yozma! Faqat "rows" massivida har bir qatorni "№|Nomi|Soni va birligi|1 dona narxi|Qator jami summasi" formatida qaytar.
3. Eng pastdagi skidkagacha bo'lgan jami summani (subtotalBeforeDiscount), skidka foizini (discountPercent), skidka summasini (discountAmount) va qog'ozda yozilgan yakuniy summani (printedFinalTotal) yoz.
4. Agar $, USD, USDT, у.е. bo'lsa yoki narxlar kichik kasr sonlarda (1.25, 102.17) bo'lsa -> currency="USD", aks holda "UZS". Sentlarni aslo yaxlitlama!

Javobni FAQAT ushbu qisqa JSON formatda qaytar:
{
  "supplierName": "Milter",
  "invoiceNumber": "145",
  "invoiceDate": "2026-11-14",
  "currency": "UZS",
  "rows": [
    "1|Marvari shokolad|10 kor|45000|450000",
    "2|Milter Mayonez 500g|20 dona|15000|300000"
  ],
  "subtotalBeforeDiscount": 2000000,
  "discountPercent": 5,
  "discountAmount": 100000,
  "printedFinalTotal": 1900000
}`;

export async function generateContentWithFallback(
  aiCall: (modelName: string) => Promise<any>,
  models: string[] = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']
) {
  let lastError: any = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          aiCall(model),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`Model ${model} request timed out (12s)`)), 12000);
          }),
        ]);
      } catch (error: any) {
        lastError = error;
        const isRetryable =
          [503, 429].includes(error?.status) || /503|429|timed out|fetch failed/i.test(error?.message || '');
        if (isRetryable && attempt < 2) {
          logger.warn(`Model ${model} busy/slow (${error?.message?.slice(0, 60)}), retrying...`);
          await new Promise((res) => setTimeout(res, 800));
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

const askJson = async (parts: any[], maxOutputTokens?: number, models?: string[]) => {
  const res = await generateContentWithFallback(
    (model) =>
      ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0,
          topK: 1,
          thinkingConfig: { thinkingBudget: 0 },
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        },
      }),
    models
  );
  if (!res.text) throw new Error('Empty response from Gemini');
  return JSON.parse(res.text);
};

/**
 * MODUL 1.3: Ultra-fast (<0.001s) Node.js parser for compact scanner `rows` ("№|Nomi|Soni|Narxi|Summasi").
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
    const unit = (qtyMatch?.[2] || '').replace(/[xх*]/gi, '').trim() || 'dona';

    const parsedPrice = parseCurrencyAndAmount(priceCol);
    const itemCurrency: 'UZS' | 'USD' =
      parsedPrice.currency === 'USD' || /\$/i.test(priceCol) || /\$/i.test(totalCol) ? 'USD' : defaultCurrency;
    const unitPrice = Number(parsedPrice.amount.toFixed(2));
    const parsedTotal = totalCol ? parseCurrencyAndAmount(totalCol).amount : Number((quantity * unitPrice).toFixed(2));
    const lineTotal = Number((parsedTotal > 0 ? parsedTotal : quantity * unitPrice).toFixed(2));
    const cleanRawName = rawName.trim();
    const normalizedName = TranslitService.toLatin(cleanRawName).toLowerCase().trim() || cleanRawName.toLowerCase();

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
      const nameCol = firstIsIndex ? cols[1] : cols[0];
      const qtyCol = firstIsIndex ? cols[2] : cols[1] || '1';
      const priceCol = firstIsIndex ? cols[3] : cols[2] || '0';
      const totalCol = firstIsIndex ? cols[4] : cols[3] || '';

      const qtyMatch = qtyCol.match(/(\d+(?:[.,]\d+)?)\s*(.*)/);
      const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) || 1 : 1;
      const unit = (qtyMatch?.[2] || '').replace(/[xх*]/gi, '').trim() || 'dona';

      const parsedPrice = parseCurrencyAndAmount(priceCol);
      const itemCurrency: 'UZS' | 'USD' =
        parsedPrice.currency === 'USD' || /\$/i.test(priceCol) || /\$/i.test(totalCol) ? 'USD' : defaultCurrency;
      const unitPrice = parsedPrice.amount;
      const parsedTotal = totalCol ? parseCurrencyAndAmount(totalCol).amount : Number((quantity * unitPrice).toFixed(2));
      const lineTotal = parsedTotal > 0 ? parsedTotal : Number((quantity * unitPrice).toFixed(2));

      extracted.push(
        InvoiceItemSchema.parse({
          rawName: nameCol,
          normalizedName: TranslitService.toLatin(nameCol).toLowerCase().trim(),
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
    const qtyText = `${it.quantity} ${it.unit || 'dona'}`.trim();
    const priceText = formatCurrency(it.unitPrice, cur);
    const totalText = formatCurrency(it.lineTotal ?? it.totalPrice, cur);
    return `| ${idx + 1} | ${it.rawName || it.productName} | ${qtyText} | ${priceText} | ${totalText} |`;
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

  // MODUL 2: Double-Discount Guard reconciliation
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
      : String(raw.verbatimText || raw.table_text || '').trim();

  const supplierName = (caption || raw.supplierName || raw.supplier || "Noma'lum").trim();
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
    supplier: raw.supplier ?? supplierName,
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
  static async parseInvoiceImage(
    imageBuffer: Buffer,
    mimeType = 'image/jpeg',
    caption?: string
  ): Promise<z.infer<typeof InvoiceSchema>> {
    return withRetry(
      async () => {
        logger.info('Sending invoice image to Gemini for Single-Pass Compact Scanner OCR');
        const parsed = await askJson(
          [
            { text: COMPACT_SCANNER_PROMPT },
            { inlineData: { data: imageBuffer.toString('base64'), mimeType } },
          ],
          4096,
          ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']
        );
        return normalizeVerbatimInvoice(parsed, caption);
      },
      2,
      1000,
      90000
    );
  }

  static async parseInvoiceText(invoiceText: string): Promise<z.infer<typeof InvoiceSchema>> {
    return withRetry(
      async () => {
        const prompt = `${COMPACT_SCANNER_PROMPT}\n\nFoydalanuvchi quyidagi nakladnoy matnini yubordi. Barcha qatorlarni rows massiviga va yakuniy raqamlarga ajrat:\nMatn: "${invoiceText}"`;

        const parsed = await askJson(
          [{ text: prompt }],
          4096,
          ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']
        );
        return normalizeVerbatimInvoice(parsed);
      },
      2,
      1000,
      30000
    );
  }

  static async parseVoiceNote(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<z.infer<typeof VoiceIntentSchema>> {
    return withRetry(
      async () => {
        logger.info('Sending voice note to Gemini for analysis');
        const raw = await askJson(
          [
            {
              text: `Sen do'kon yordamchisisan. Ovozli xabarni eshitib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.\n${INTENT_RULES}`,
            },
            { inlineData: { data: audioBuffer.toString('base64'), mimeType } },
          ],
          undefined,
          ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash']
        );
        if (raw.amount !== undefined && raw.amount !== null) {
          raw.amount = Number(Number(Math.abs(raw.amount)).toFixed(2));
        }
        return VoiceIntentSchema.parse(raw);
      },
      2,
      1000,
      30000
    );
  }

  static async parseTextIntent(textMessage: string): Promise<z.infer<typeof VoiceIntentSchema>> {
    return withRetry(
      async () => {
        logger.info('Sending text message to Gemini for intent analysis');
        const raw = await askJson(
          [
            {
              text: `Sen do'kon yordamchisisan. Foydalanuvchining yozgan xabarini o'qib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.\n${INTENT_RULES}\nXabar matni: "${textMessage}"`,
            },
          ],
          undefined,
          ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash']
        );

        // Deterministic currency & cent override from raw text message
        const parsedMoney = parseCurrencyAndAmount(textMessage);
        if (parsedMoney.currency === 'USD') {
          raw.currency = 'USD';
          if (parsedMoney.amount > 0) {
            raw.amount = parsedMoney.amount;
          }
        } else if (raw.amount !== undefined && raw.amount !== null) {
          raw.amount = Number(Number(Math.abs(raw.amount)).toFixed(2));
        }

        return VoiceIntentSchema.parse(raw);
      },
      2,
      1000,
      30000
    );
  }
}
