"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiService = exports.VoiceIntentSchema = exports.InvoiceSchema = exports.InvoiceItemSchema = void 0;
exports.generateContentWithFallback = generateContentWithFallback;
const genai_1 = require("@google/genai");
const zod_1 = require("zod");
const env_1 = require("../config/env");
const retry_1 = require("../utils/retry");
const logger_1 = require("../config/logger");
const ai = new genai_1.GoogleGenAI({ apiKey: env_1.env.GEMINI_API_KEY });
exports.InvoiceItemSchema = zod_1.z.object({ productName: zod_1.z.string(), quantity: zod_1.z.number(), unitPrice: zod_1.z.number(), totalPrice: zod_1.z.number() });
exports.InvoiceSchema = zod_1.z.object({
    total_amount: zod_1.z.number().default(0),
    discount: zod_1.z.number().default(0),
    table_text: zod_1.z.string().default(''),
    supplier: zod_1.z.string().optional().nullable(),
    invoiceNo: zod_1.z.string().optional().nullable(),
    supplierName: zod_1.z.string().optional().nullable(),
    grossTotal: zod_1.z.number().optional().nullable(),
    discountAmount: zod_1.z.number().optional().nullable(),
    netTotal: zod_1.z.number().optional().nullable(),
    itemsCount: zod_1.z.number().optional().nullable(),
    sampleItems: zod_1.z.array(zod_1.z.string()).optional().nullable(),
    items: zod_1.z.any().optional().nullable(),
    isCaptionOverride: zod_1.z.boolean().optional(),
    isCashOverride: zod_1.z.boolean().optional(),
    exactSupplierId: zod_1.z.string().optional().nullable(),
    discountLabel: zod_1.z.string().optional().nullable(),
});
exports.VoiceIntentSchema = zod_1.z.object({
    intent: zod_1.z.enum(['ADD_EXPENSE', 'ADD_SUPPLIER_TX', 'ADD_CUSTOMER_DEBT', 'ADD_CASH_TX', 'SEARCH_PRODUCT', 'GET_DEBT_INFO', 'GENERAL_CHAT', 'UNKNOWN']),
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
  * Agar "Yuk keldi / yuk chiqdi / yuk oldik" yoki musbat amaliyot bo'lsa (masalan: "+1 000 000 Milter", "Milter +500 ming", "Milterdan 500 minglik yuk keldi") -> txType="INCOMING_GOODS".
  * Agar "Pul berdik / to'ladik / to'lov qildim / qarzdan ayir / ayirdim" yoki manfiy amaliyot bo'lsa (masalan: "-1.000.000 Milterdan", "Milter -1.000.000", "-500 ming Akmal", "Milterdan 1 mln to'lov", "Azamatdan 500 ming ayir") -> txType="PAYMENT". Qarzdan ayirish amali!
  MUHIM: "-1.000.000 Milterdan" yoki "Milter -1 mln" kabi yozuvlar qarz so'rash EMAS, balki qarzdan ayirish (to'lov / PAYMENT) amaliyotidir!
- ADD_CASH_TX: Naqd xarid yoki naqd savdo (masalan: "Naqdga 500 minglik yuk oldim", "Naqd Nehir 200 ming"). MUHIM: Agar matnda "naqd" so'zi bo'lsa, uni albatta shu turkumga kirit.
- ADD_CUSTOMER_DEBT: Nasiyaga mol berish/mijoz qarzi (masalan: "Rustam 50 ming so'mlik narsa oldi, yozib qo'y", "Akmal nasiya 100 ming").
- SEARCH_PRODUCT: Tovarni qidirish (masalan: "Kola narxi qancha?").
- GET_DEBT_INFO: FAQAT va FAQAT qarz miqdorini SO'RASH (masalan: "Milterdan qancha qarzim bor?", "Milter qarzi qancha?", "Akmalning qarzi qancha bo'ldi?"). Agar xabarda aniq amaliyot summasi yoki -/+ belgisi bo'lsa (masalan "-1 000 000"), bu qarz so'rash EMAS!
- GENERAL_CHAT: Yuqoridagilardan tashqari erkin savdo, maslahat, yordam so'ralganda. Bunday holatda "replyText" ga o'zbek tilida to'liq maslahatchi sifatida professional javobni yoz.
- UNKNOWN: Agar butunlay tushunarsiz yoki aloqasiz bo'lsa.
Summalarni (amount) doim MUSBAT (Math.abs) qilib raqamda yoz. Valyutani (currency) UZS yoki USD qilib belgil.
Ism/nomni (name) kirit (ta'minotchi, mijoz yoki tovar nomi). Javob faqat JSON formatda bo'lsin.`;
async function generateContentWithFallback(aiCall, models = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']) {
    let lastError = null;
    for (const model of models) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            let timer;
            try {
                return await Promise.race([
                    aiCall(model),
                    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Model ${model} request timed out (12s)`)), 12000); })
                ]);
            }
            catch (error) {
                lastError = error;
                const isRetryable = [503, 429].includes(error?.status) || /503|429|timed out|fetch failed/i.test(error?.message || '');
                if (isRetryable && attempt < 2) {
                    logger_1.logger.warn(`Model ${model} busy/slow (${error?.message?.slice(0, 60)}), retrying...`);
                    await new Promise(res => setTimeout(res, 800));
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
const askJson = async (parts, maxOutputTokens, models) => {
    const res = await generateContentWithFallback(model => ai.models.generateContent({ model, contents: [{ role: 'user', parts }], config: { responseMimeType: 'application/json', temperature: 0.1, ...(maxOutputTokens ? { maxOutputTokens } : {}) } }), models);
    if (!res.text)
        throw new Error('Empty response from Gemini');
    return JSON.parse(res.text);
};
class AiService {
    static async parseInvoiceImage(imageBuffer, mimeType = 'image/jpeg', caption) {
        return (0, retry_1.withRetry)(async () => {
            logger_1.logger.info('Sending invoice image to Gemini for Pure OCR + Target Extraction');
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
            const parsed = await askJson([{ text: textPrompt }, { inlineData: { data: imageBuffer.toString('base64'), mimeType } }], 8192, ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
            parsed.total_amount = Number(parsed.total_amount ?? parsed.totalOnPaper ?? parsed.grossTotal ?? 0);
            parsed.discount = Number(parsed.discount ?? parsed.discountOnPaper ?? parsed.discountAmount ?? 0);
            parsed.table_text = String(parsed.table_text ?? '');
            parsed.supplierName = caption || parsed.supplier || parsed.supplierName || "Noma'lum";
            parsed.discountAmount = parsed.discount;
            parsed.grossTotal = parsed.total_amount;
            parsed.netTotal = parsed.total_amount - parsed.discount;
            const tableLines = parsed.table_text.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---'));
            const dataRows = tableLines.length > 1 ? tableLines.slice(1) : tableLines;
            parsed.sampleItems = dataRows.slice(0, 4).map((row) => {
                const cols = row.split('|').map((c) => c.trim()).filter(Boolean);
                return cols[1] || cols[0] || row;
            });
            parsed.itemsCount = dataRows.length > 0 ? dataRows.length : 1;
            return exports.InvoiceSchema.parse(parsed);
        }, 2, 1000, 90000);
    }
    static async parseInvoiceText(invoiceText) {
        return (0, retry_1.withRetry)(async () => {
            const prompt = `Sen do'kon yordamchisisan. Foydalanuvchi quyidagi nakladnoy matnini tahrirlab yubordi. Undan ta'minotchi nomi, nakladnoy raqami va barcha tovarlarni, ularning sonini, donasi narxini va umumiy narxini JSON formatda ajratib ol.
Qoida: Har bir qatorda quantity * unitPrice == totalPrice bo'lishi shart. Agar matnda totalPrice berilmagan bo'lsa, o'zing hisobla.
Javob faqat quyidagi JSON formatida bo'lsin:
{"supplierName":"MCHJ Nomi","invoiceNo":"12345","total_amount":50000,"discount":0,"table_text":"| Tovar | Soni | Narxi | Jami |","items":[{"productName":"Tovar nomi","quantity":10,"unitPrice":5000,"totalPrice":50000}]}
Matn: "${invoiceText}"`;
            const parsed = await askJson([{ text: prompt }], 8192, ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']);
            parsed.grossTotal = parsed.total_amount = Number(parsed.total_amount ?? parsed.grossTotal ?? 0);
            parsed.discountAmount = parsed.discount = Number(parsed.discount ?? parsed.discountAmount ?? 0);
            parsed.table_text = String(parsed.table_text ?? '');
            return exports.InvoiceSchema.parse(parsed);
        }, 2, 1000, 30000);
    }
    static async parseVoiceNote(audioBuffer, mimeType = 'audio/ogg') {
        return (0, retry_1.withRetry)(async () => {
            logger_1.logger.info('Sending voice note to Gemini for analysis');
            return exports.VoiceIntentSchema.parse(await askJson([
                { text: `Sen do'kon yordamchisisan. Ovozli xabarni eshitib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.\n${INTENT_RULES}` },
                { inlineData: { data: audioBuffer.toString('base64'), mimeType } }
            ], undefined, ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash']));
        }, 2, 1000, 30000);
    }
    static async parseTextIntent(textMessage) {
        return (0, retry_1.withRetry)(async () => {
            logger_1.logger.info('Sending text message to Gemini for intent analysis');
            return exports.VoiceIntentSchema.parse(await askJson([
                { text: `Sen do'kon yordamchisisan. Foydalanuvchining yozgan xabarini o'qib, uning maqsadini (intent) va kerakli ma'lumotlarni JSON formatida qaytar.\n${INTENT_RULES}\nXabar matni: "${textMessage}"` }
            ], undefined, ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash']));
        }, 2, 1000, 30000);
    }
}
exports.AiService = AiService;
