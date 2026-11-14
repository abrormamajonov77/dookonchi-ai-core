import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env';
import { withRetry } from '../utils/retry';
import { logger } from '../config/logger';
import { TranslitService } from './translit.service';
import { calculateDiscountedTotal, formatCurrency, parseCurrencyAndAmount } from '../utils/formatters';

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
  discount: z.number().default(0),
  finalTotal: z.number().optional().nullable(),
  currency: z.enum(['UZS', 'USD']).default('UZS'),
  verbatimText: z.string().default(''),
  table_text: z.string().default(''),
  supplier: z.string().optional().nullable(),
  invoiceNo: z.string().optional().nullable(),
  supplierName: z.string().optional().nullable(),
  grossTotal: z.number().optional().nullable(),
  discountAmount: z.number().optional().nullable(),
  netTotal: z.number().optional().nullable(),
  itemsCount: z.number().optional().nullable(),
  sampleItems: z.array(z.string()).optional().nullable(),
  items: z.any().optional().nullable(),
  isCaptionOverride: z.boolean().optional(),
  isCashOverride: z.boolean().optional(),
  exactSupplierId: z.string().optional().nullable(),
  discountLabel: z.string().optional().nullable(),
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

const VERBATIM_OCR_SYSTEM_PROMPT = `Sen tezyurar va o'ta aniq hujjat skanerisansan (100% Verbatim Kserokopiya OCR Mode).
QOIDA:
1. Nakladnoydagi BARCHA qatorlarni 1-qatordan oxirgi qatorgacha hech bir so'zni qisqartirmasdan, 100% birga-bir "Kserokopiya" (Verbatim) shaklida o'qi!
2. Har bir qatorda: № | Mahsulotning nakladnoydagi aniq nomi | Soni / O'lchov birligi | 1 dona narxi (Kelish narxi) | Qator jami summasi to'liq chiqishi shart (valyutasi bilan: so'm yoki $).
3. AI qatorlarni bir-biriga qo'shib ichki kalkulyatsiya qilmasin (vaqt ketmasligi va adashmasligi uchun), faqat nakladnoyda yozilgan raqamlarni shundayligicha ko'chirsin va eng pastdagi Umumiy summa (rawTotal), Skidka (discount), To'lanadigan yakuniy summa (finalTotal) hamda Valyuta (currency: "UZS" | "USD") ni ajratib bersin.
4. VALYUTA QOIDASI: Agar nakladnoyda $, USD, USDT, у.е. belgisi bo'lsa yoki narxlar kichik kasr sonlarda (masalan, 1.25, 102.17) yozilgan bo'lsa, currency: 'USD' qaytar va kasr qismini (sentlarni, masalan .17) aslo yaxlitlama!

Javobni FAQAT quyidagi JSON formatida qaytar:
{
  "supplier": "Ta'minotchi nomi",
  "invoiceNo": "12345",
  "currency": "UZS",
  "rawTotal": 1280400,
  "discount": 0,
  "finalTotal": 1280400,
  "verbatimText": "| № | Mahsulot nomi | Soni | Narxi | Summasi |\\n|---|---|---|---|---|\\n| 1 | Marvari shokolad | 10 korobka | 45,000 so'm | 450,000 so'm |",
  "items": [
    {
      "rawName": "Marvari shokolad",
      "normalizedName": "marvari shokolad",
      "quantity": 10,
      "unit": "korobka",
      "unitPrice": 45000,
      "lineTotal": 450000,
      "currency": "UZS"
    }
  ]
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
          temperature: 0.1,
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        },
      }),
    models
  );
  if (!res.text) throw new Error('Empty response from Gemini');
  return JSON.parse(res.text);
};

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
    // Skip markdown header separator lines like |---|---|
    if (/^\|?[\s\-:|]+\|?$/.test(line)) continue;

    if (line.includes('|')) {
      const cols = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cols.length < 2) continue;

      // Skip table header row
      const joinedLower = cols.join(' ').toLowerCase();
      if (
        (joinedLower.includes('mahsulot') || joinedLower.includes('tovar') || joinedLower.includes('наименование')) &&
        (joinedLower.includes('narx') || joinedLower.includes('soni') || joinedLower.includes('цена') || joinedLower.includes('сумма'))
      ) {
        continue;
      }

      // Determine column positions: either [No, Name, Qty, UnitPrice, LineTotal] or [Name, Qty, UnitPrice, LineTotal]
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
    /\$|usd|usdt|у\.е/i.test(String(raw.verbatimText || raw.table_text || ''))
      ? 'USD'
      : 'UZS';

  let items: ParsedInvoiceItem[] = [];
  if (Array.isArray(raw.items) && raw.items.length > 0) {
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
  const rawTotalCandidate = Number(
    raw.rawTotal ?? raw.originalAmount ?? raw.grossTotal ?? raw.total_amount ?? (itemsSum > 0 ? itemsSum : 0)
  );
  const rawDiscountInput = raw.discountLabel ?? raw.discount ?? raw.discountAmount ?? 0;

  const mathResult = calculateDiscountedTotal(rawTotalCandidate, rawDiscountInput);
  const verbatimText =
    items.length > 0
      ? buildVerbatimTableText(items, currency)
      : String(raw.verbatimText || raw.table_text || '').trim();

  const supplierName = (caption || raw.supplier || raw.supplierName || "Noma'lum").trim();

  return InvoiceSchema.parse({
    ...raw,
    currency,
    rawTotal: mathResult.rawTotal,
    total_amount: mathResult.rawTotal,
    grossTotal: mathResult.rawTotal,
    discount: mathResult.discountAmount,
    discountAmount: mathResult.discountAmount,
    finalTotal: mathResult.finalTotal,
    netTotal: mathResult.finalTotal,
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
        logger.info('Sending invoice image to Gemini for 100% Verbatim OCR + Structured Items Extraction');
        const parsed = await askJson(
          [
            { text: VERBATIM_OCR_SYSTEM_PROMPT },
            { inlineData: { data: imageBuffer.toString('base64'), mimeType } },
          ],
          8192,
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
        const prompt = `${VERBATIM_OCR_SYSTEM_PROMPT}\n\nFoydalanuvchi quyidagi nakladnoy matnini yubordi. Barcha qatorlarni 100% kserokopiya shaklida verbatimText va items massiviga ajrat:\nMatn: "${invoiceText}"`;

        const parsed = await askJson(
          [{ text: prompt }],
          8192,
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
