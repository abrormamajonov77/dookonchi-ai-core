import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env';
import { withRetry } from '../utils/retry';
import { z } from 'zod';
import { logger } from '../config/logger';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const MODEL = 'gemini-3.8-flash';

export const InvoiceItemSchema = z.object({
  productName: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  totalPrice: z.number()
});

export const InvoiceSchema = z.object({
  total_amount: z.number().default(0),
  discount: z.number().default(0),
  table_text: z.string().default(''),
  supplier: z.string().optional().nullable(),
  invoiceNo: z.string().optional().nullable(),
  supplierName: z.string().optional().nullable(),
  grossTotal: z.number().optional().nullable(),
  discountAmount: z.number().optional().nullable(),
  netTotal: z.number().optional().nullable(),
  itemsCount: z.number().optional().nullable(),
  sampleItems: z.array(z.string()).optional().nullable(),
  items: z.any().optional().nullable(), // Can be string[] or InvoiceItemSchema[]
  isCaptionOverride: z.boolean().optional(),
  isCashOverride: z.boolean().optional(),
  exactSupplierId: z.string().optional().nullable(),
  discountLabel: z.string().optional().nullable(),
});

export const VoiceIntentSchema = z.object({
  intent: z.enum(['ADD_EXPENSE', 'ADD_SUPPLIER_TX', 'ADD_CUSTOMER_DEBT', 'ADD_CASH_TX', 'SEARCH_PRODUCT', 'GET_DEBT_INFO', 'GENERAL_CHAT', 'UNKNOWN']),
  txType: z.enum(['INCOMING_GOODS', 'PAYMENT']).optional().nullable().describe('Only required if intent is ADD_SUPPLIER_TX'),
  amount: z.number().optional().nullable(),
  currency: z.enum(['UZS', 'USD']).nullable().optional().default('UZS'),
  name: z.string().optional().nullable().describe('Supplier name, Customer name, or Product name depending on intent'),
  category: z.string().optional().nullable().describe('Expense category if ADD_EXPENSE'),
  comment: z.string().optional().nullable(),
  replyText: z.string().optional().nullable().describe('The free-form conversational AI response for GENERAL_CHAT intent'),
});

import { fuzzyMatch } from '../utils/fuzzy';

const KNOWN_PRODUCTS = [
  "Donya", "Yarkoye", "Яркое", "Zateya", "Shedevr", "Oltin Kalit", "Shakar", "Un", 
  "Ogorod", "Огород", "Bondtchel", "Бонджел", "Grand", "Halaca", "Pishloq", "Kolbasa"
];

const VISION_TIMEOUT_MS = 60000;
const TEXT_TIMEOUT_MS = 10000;

export async function generateContentWithFallback(
  aiCall: (modelName: string) => Promise<any>,
  models: string[] = ['gemini-3.8-flash']
) {
  let lastError: any = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await aiCall(model);
      } catch (error: any) {
        lastError = error;
        const isBusy = error?.status === 503 || error?.message?.includes('503') || error?.status === 429 || error?.message?.includes('429');
        if (isBusy && attempt < 2) {
          logger.warn(`Model ${model} is busy (503/429), retrying attempt ${attempt + 1}...`);
          await new Promise(res => setTimeout(res, 1500));
          continue;
        }
        logger.warn(`Model ${model} failed, switching to next model if available. Error: ${error?.message}`);
        break;
      }
    }
  }
  throw lastError;
}

export class AiService {
  static async parseInvoiceImage(imageBuffer: Buffer, mimeType: string = 'image/jpeg', caption?: string): Promise<z.infer<typeof InvoiceSchema>> {
    return withRetry(async () => {
      logger.info('Sending invoice image to Gemini for Pure OCR + Target Extraction');
      const textPrompt = `Sen tezyurar va o'ta aniq hujjat skanerisansan (Pure OCR Mode).
Vazifang: Ushbu nakladnoy/chek tasviridagi barcha jadval ma'lumotlarini qanday bo'lsa shundayligicha ko'chirib berish va pastki yakuniy summalarni ajratish.

QAT'IY QOIDALAR:
1. HECH QANDAY QAYTA HISOBLASH, MATEMATIKA, QATORLARNI YIG'ISH YOKI TEKSHIRISH QILMA! (No in-model arithmetic/reconciliation). Qatordagi sonlar qog'ozda qanday yozilgan bo'lsa, xuddi shunday so'zma-so'z ko'chir.
2. Butun jadvalni boshidan oxirigacha birorta qatorini qoldirmasdan yoki qisqartirmasdan toza Markdown jadvali ("table_text") ko'rinishida ko'chir.
3. Chekning eng pastki qismidagi yakuniy jami qatorlaridan FAQAT IKKITA maqsadli sonni ajratib ol:
   - "total_amount": Chekning eng pastki qismida "ИТОГО / ВСЕГО / К ОПЛАТЕ" deb ko'rsatilgan yakuniy summa (faqat son).
   - "discount": Agar qog'ozda "Скидка" katagida chegirma bo'lsa o'sha summa (yo'q bo'lsa 0).
4. Chek yuqorisidagi ta'minotchi / firma nomini ("supplier") va nakladnoy raqamini ("invoiceNo") ham ajrat.

Javobni FAQAT quyidagi JSON formatida qaytar:
{
  "total_amount": 1280400,
  "discount": 0,
  "table_text": "| № | Tovar nomi | Soni | Narxi | Summasi |\\n|---|---|---|---|---|\\n| 1 | Mahsulot 1 | 5 | 10000 | 50000 |",
  "supplier": "Ta'minotchi nomi",
  "invoiceNo": "12345"
}`;

      const response = await generateContentWithFallback(async (modelName) => {
        return await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [
                { text: textPrompt },
                { inlineData: { data: imageBuffer.toString('base64'), mimeType } }
              ]
            }
          ],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 8192,
          }
        });
      });

      const text = response.text;
      if (!text) throw new Error('Empty response from Gemini');
      
      const parsed = JSON.parse(text);
      
      parsed.total_amount = Number(parsed.total_amount ?? parsed.totalOnPaper ?? parsed.grossTotal ?? 0);
      parsed.discount = Number(parsed.discount ?? parsed.discountOnPaper ?? parsed.discountAmount ?? 0);
      parsed.table_text = String(parsed.table_text ?? '');
      
      // Adapt to legacy internal handler formats
      parsed.supplierName = parsed.supplier || parsed.supplierName || "Noma'lum";
      if (caption) parsed.supplierName = caption;
      parsed.discountAmount = parsed.discount;
      parsed.grossTotal = parsed.total_amount;
      parsed.netTotal = parsed.total_amount - parsed.discount;
      
      // Extract sample items preview from table_text
      const tableLines = parsed.table_text.split('\n').filter((l: string) => l.trim().startsWith('|') && !l.includes('---'));
      const dataRows = tableLines.length > 1 ? tableLines.slice(1) : tableLines;
      parsed.sampleItems = dataRows.slice(0, 4).map((row: string) => {
        const cols = row.split('|').map((c: string) => c.trim()).filter(Boolean);
        return cols[1] || cols[0] || row;
      });
      parsed.itemsCount = dataRows.length > 0 ? dataRows.length : 1;
      
      return InvoiceSchema.parse(parsed);
    }, 2, 1000, VISION_TIMEOUT_MS);
  }

  static async parseInvoiceText(invoiceText: string): Promise<z.infer<typeof InvoiceSchema>> {
    return withRetry(async () => {
      const response = await generateContentWithFallback(async (modelName) => {
        return await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Sen do'kon yordamchisisan. Foydalanuvchi quyidagi nakladnoy matnini tahrirlab yubordi. Undan ta'minotchi nomi, nakladnoy raqami va barcha tovarlarni, ularning sonini, donasi narxini va umumiy narxini JSON formatda ajratib ol.
Qoida: Har bir qatorda quantity * unitPrice == totalPrice bo'lishi shart. Agar matnda totalPrice berilmagan bo'lsa, o'zing hisobla.

Javob faqat va faqat quyidagi JSON formatida bo'lsin:
{
  "supplierName": "MCHJ Nomi",
  "invoiceNo": "12345",
  "total_amount": 50000,
  "discount": 0,
  "table_text": "| Tovar | Soni | Narxi | Jami |",
  "items": [
    { "productName": "Tovar nomi", "quantity": 10, "unitPrice": 5000, "totalPrice": 50000 }
  ]
}

Matn:
"${invoiceText}"`
                }
              ]
            }
          ],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 8192,
          }
        });
      });

      const text = response.text;
      if (!text) throw new Error('Empty response from Gemini');
      
      const parsed = JSON.parse(text);
      parsed.total_amount = Number(parsed.total_amount ?? parsed.grossTotal ?? 0);
      parsed.discount = Number(parsed.discount ?? parsed.discountAmount ?? 0);
      parsed.grossTotal = parsed.total_amount;
      parsed.discountAmount = parsed.discount;
      parsed.table_text = String(parsed.table_text ?? '');
      return InvoiceSchema.parse(parsed);
    }, 2, 1000, TEXT_TIMEOUT_MS);
  }

  static async parseVoiceNote(audioBuffer: Buffer, mimeType: string = 'audio/ogg'): Promise<z.infer<typeof VoiceIntentSchema>> {
    return withRetry(async () => {
      logger.info('Sending voice note to Gemini for analysis');
      const response = await generateContentWithFallback(async (modelName) => {
        return await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Sen do'kon yordamchisisan. Ovozli xabarni eshitib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.
Maqsadlar (intent):
- ADD_EXPENSE: Xarajat kiritish (masalan: "Ijaraga 500 dollar berdim", "Elektrga 200 ming so'm to'ladim").
- ADD_SUPPLIER_TX: Ta'minotchi bilan oldi-berdi amaliyoti (qarzga). Agar "Yuk keldi / yuk chiqdi / yuk oldik" deyilgan bo'lsa txType="INCOMING_GOODS" bo'ladi. Agar "Pul berdik / to'ladik / to'lov qildim" deyilsa txType="PAYMENT" bo'ladi.
- ADD_CASH_TX: Naqd xarid yoki naqd savdo (masalan: "Naqdga 500 minglik yuk oldim", "Naqd Nehir 200 ming"). MUHIM: Agar matnda "naqd" so'zi bo'lsa, uni albatta shu turkumga kirit.
- ADD_CUSTOMER_DEBT: Nasiyaga mol berish/mijoz qarzi (masalan: "Rustam 50 ming so'mlik narsa oldi, yozib qo'y").
- SEARCH_PRODUCT: Tovarni qidirish (masalan: "Kola narxi qancha?").
- GET_DEBT_INFO: Qarz miqdorini so'rash (masalan: "Milterdan qancha qarzim bor?", "Akmalning qarzi qancha?").
- GENERAL_CHAT: Yuqoridagilardan tashqari erkin savdo, maslahat, yordam so'ralganda (masalan: "Qanday qilib savdoni ko'paytirsam bo'ladi?"). Bunday holatda "replyText" ga o'zbek tilida to'liq yordamchi sifatidagi javobni qaytar.
- UNKNOWN: Agar butunlay tushunarsiz yoki xato bo'lsa.

Summalarni (amount) raqamda yoz. Valyutani (currency) UZS yoki USD qilib belgil.
Ism/nomni (name) kirit (ta'minotchi, mijoz yoki tovar nomi).
Javob faqat JSON formatda bo'lsin.`
                },
                {
                  inlineData: {
                    data: audioBuffer.toString('base64'),
                    mimeType
                  }
                }
              ]
            }
          ],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          }
        });
      });

      const text = response.text;
      if (!text) throw new Error('Empty response from Gemini');
      
      const parsed = JSON.parse(text);
      return VoiceIntentSchema.parse(parsed);
    }, 2, 1000, TEXT_TIMEOUT_MS);
  }

  static async parseTextIntent(textMessage: string): Promise<z.infer<typeof VoiceIntentSchema>> {
    return withRetry(async () => {
      logger.info('Sending text message to Gemini for intent analysis');
      const response = await generateContentWithFallback(async (modelName) => {
        return await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Sen do'kon yordamchisisan. Foydalanuvchining yozgan xabarini o'qib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.
Maqsadlar (intent):
- ADD_EXPENSE: Xarajat kiritish (masalan: "Ijaraga 500 dollar berdim", "Elektrga 200 ming so'm to'ladim").
- ADD_SUPPLIER_TX: Ta'minotchi bilan oldi-berdi amaliyoti (qarzga). Agar "Yuk keldi / yuk chiqdi / yuk oldik" deyilgan bo'lsa txType="INCOMING_GOODS" bo'ladi. Agar "Pul berdik / to'ladik / to'lov qildim" deyilsa txType="PAYMENT" bo'ladi.
- ADD_CASH_TX: Naqd xarid yoki naqd savdo (masalan: "Naqdga 500 minglik yuk oldim", "Naqd Nehir 200 ming"). MUHIM: Agar matnda "naqd" so'zi bo'lsa, uni albatta shu turkumga kirit.
- ADD_CUSTOMER_DEBT: Nasiyaga mol berish/mijoz qarzi (masalan: "Rustam 50 ming so'mlik narsa oldi, yozib qo'y").
- SEARCH_PRODUCT: Tovarni qidirish (masalan: "Kola narxi qancha?").
- GET_DEBT_INFO: Qarz miqdorini so'rash (masalan: "Milterdan qancha qarzim bor?", "Akmalning qarzi qancha?").
- GENERAL_CHAT: Yuqoridagilardan tashqari erkin savdo, maslahat, yordam so'ralganda. Bunday holatda "replyText" ga o'zbek tilida to'liq maslahatchi sifatida professional javobni yoz.
- UNKNOWN: Agar butunlay tushunarsiz yoki aloqasiz bo'lsa.

Summalarni (amount) raqamda yoz. Valyutani (currency) UZS yoki USD qilib belgil.
Ism/nomni (name) kirit (ta'minotchi, mijoz yoki tovar nomi).
Javob faqat JSON formatda bo'lsin.
Xabar matni: "${textMessage}"`
                }
              ]
            }
          ],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          }
        });
      });

      const text = response.text;
      if (!text) throw new Error('Empty response from Gemini');
      
      const parsed = JSON.parse(text);
      return VoiceIntentSchema.parse(parsed);
    }, 2, 1000, TEXT_TIMEOUT_MS);
  }
}
