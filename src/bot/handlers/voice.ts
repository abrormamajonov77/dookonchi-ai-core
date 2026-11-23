import { Composer, InlineKeyboard } from 'grammy';
import Fuse from 'fuse.js';
import { Prisma } from '@prisma/client';
import { MyContext } from '../context';
import { AiService } from '../../services/ai.service';
import {
  getConfirmationKeyboard,
  getDisambiguationKeyboard,
  getFuzzySupplierSuggestionKeyboard,
  getPaymentSourceConfirmationKeyboard,
} from '../keyboards/inline';
import { isMenuButton } from '../keyboards/menu';
import { logger } from '../../config/logger';
import { formatCurrency, formatSom, formatUsd } from '../../utils/formatters';
import { prisma } from '../../database/prisma';
import {
  withChatAction,
  downloadTelegramFile,
  clearSession,
  formatFriendlyError,
  safeEditMessageText,
  safeReply,
  sanitizeMdV1,
  findOwnedPendingAction,
  deleteOwnedPendingAction,
} from '../../utils/telegram';
import { SupplierService } from '../../services/supplier.service';
import { SearchService } from '../../services/search.service';
import { parseTextCommandLocally } from '../../utils/local-parser';
import { normalizeForSearch, toLatinUz } from '../../utils/transliterate';

export const voiceHandler = new Composer<MyContext>();

const EXPIRED_MSG =
  "⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.";
const NEW_SUPP_PROMPT =
  "Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):";

export function parseShorthandTx(text: string) {
  const local = parseTextCommandLocally(text);
  if (!local) return null;
  if (
    local.intent !== 'INVOICE_CASH' &&
    local.intent !== 'INVOICE_CREDIT' &&
    local.intent !== 'SUPPLIER_PAYMENT'
  ) {
    return null;
  }
  return {
    txType: (local.intent === 'SUPPLIER_PAYMENT' ? 'PAYMENT' : 'INCOMING_GOODS') as
      | 'PAYMENT'
      | 'INCOMING_GOODS',
    amount: local.amount,
    currency: local.currency,
    name: local.supplierName,
    paymentType: local.paymentType,
    paymentSource: local.paymentSource,
    hasExplicitSource: local.hasExplicitSource,
  };
}

async function saveSupplierTxData(
  data: any,
  ownerId: string,
  overrideSource?: 'TODAY_CASH' | 'PREVIOUS_SAFE'
): Promise<number> {
  const currency: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  const amount = Number(Math.abs(Number(data.amount || 0)).toFixed(2));
  const paymentSource: 'TODAY_CASH' | 'PREVIOUS_SAFE' =
    overrideSource || data.paymentSource || 'TODAY_CASH';
  const cleanName = toLatinUz(data.name || data.supplierName || "Noma'lum").trim();
  const supplierId =
    data.exactSupplierId && data.exactSupplierId !== 'CREATE_NEW'
      ? data.exactSupplierId
      : undefined;

  // 1. CASH purchase ("Sirok 500.000 naqd")
  if (data.paymentType === 'CASH' || data.intent === 'INVOICE_CASH' || data.intent === 'ADD_CASH_TX') {
    const res = await SupplierService.createInvoiceWithItems({
      ownerId,
      supplierId,
      supplierName: cleanName,
      rawTotal: amount,
      discountInput: 0,
      currency,
      paymentType: 'CASH',
      paymentSource,
      paidCashAmount: amount,
      creditAmount: 0,
      forceOverrideDuplicate: true,
    });
    return currency === 'USD' ? Number(res.supplier.debtUsd) : Number(res.supplier.debtUzs);
  }

  // 2. PAYMENT to supplier
  if (data.txType === 'PAYMENT' || data.intent === 'SUPPLIER_PAYMENT') {
    const res = await SupplierService.recordSupplierPayment({
      ownerId,
      supplierId,
      supplierName: cleanName,
      amount,
      currency,
      paymentSource,
      comment:
        data.comment ||
        (paymentSource === 'PREVIOUS_SAFE' ? "Kechagi puldan / Seyfdan to'lov" : "Bugungi kassadan to'lov"),
    });
    return currency === 'USD' ? Number(res.supplier.debtUsd) : Number(res.supplier.debtUzs);
  }

  // 3. CREDIT incoming goods — unified through SupplierService.createInvoiceWithItems (atomic debt increment)
  const commentText = data.comment ? `Izoh: ${toLatinUz(data.comment)}` : 'Matn/ovozli xabar orqali kiritildi';
  const res = await SupplierService.createInvoiceWithItems({
    ownerId,
    supplierId,
    supplierName: cleanName,
    rawTotal: amount,
    discountInput: 0,
    currency,
    paymentType: 'CREDIT',
    paymentSource: 'TODAY_CASH',
    paidCashAmount: 0,
    creditAmount: amount,
    verbatimText: `Yuk olish - ${formatCurrency(amount, currency)}\n${commentText}`,
    forceOverrideDuplicate: true,
  });
  return currency === 'USD' ? Number(res.supplier.debtUsd) : Number(res.supplier.debtUzs);
}

async function handleZeroMenuProductSearch(ctx: MyContext, ownerId: string, rawQuery: string) {
  const query = toLatinUz(rawQuery || '').trim();
  if (!query) {
    return ctx.reply("🔍 Qaysi mahsulot narxini qidiramiz? Masalan: `ole narxi`", { parse_mode: 'Markdown' });
  }
  const items = await SearchService.searchProductsWithPriceDiff(query, ownerId);
  if (!items.length) {
    return ctx.reply(`🤷‍♂️ "${query}" nomli mahsulot bazadan topilmadi.`);
  }

  const topItems = items.slice(0, 5);
  const kb = new InlineKeyboard();
  const seenSupIds = new Set<string>();
  for (const it of topItems) {
    if (it.supplierId && !seenSupIds.has(it.supplierId) && seenSupIds.size < 3) {
      seenSupIds.add(it.supplierId);
      kb.text(`🏢 ${it.partyName.slice(0, 28)}`, `sup:v:${it.supplierId}`).row();
    }
  }

  const header =
    items.length > topItems.length
      ? `🔎 **"${sanitizeMdV1(query)}" bo'yicha top-${topItems.length} natija (jami ${items.length} ta):**\n\n`
      : '';
  return safeReply(ctx, header + topItems.map((i) => i.formattedCard).join('\n\n────────────────────\n\n'), {
    reply_markup: kb.inline_keyboard.length > 0 ? kb : undefined,
  });
}

async function handleZeroMenuDebtLookup(ctx: MyContext, ownerId: string, rawName: string) {
  const query = toLatinUz(rawName || '').trim();
  const isAll = !query || query.toUpperCase() === 'ALL';

  const [allSuppliers, allDebts] = await Promise.all([
    prisma.supplier.findMany({
      where: { ownerId, isActive: true },
      orderBy: [{ debtUzs: 'desc' }, { debtUsd: 'desc' }],
      select: { id: true, name: true, debtUzs: true, debtUsd: true },
    }),
    prisma.customerDebt.findMany({
      where: { ownerId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, customerName: true, amount: true, paidAmount: true, currency: true },
    }),
  ]);

  const customerMap = new Map<
    string,
    { name: string; searchName: string; firstId: string; uzs: number; usd: number }
  >();
  for (const d of allDebts) {
    const rem = Number((Number(d.amount) - Number(d.paidAmount)).toFixed(2));
    if (rem <= 0) continue;
    const cleanCust = toLatinUz(d.customerName).trim();
    const key = cleanCust.toLowerCase();
    const existing = customerMap.get(key) || {
      name: cleanCust,
      searchName: normalizeForSearch(cleanCust),
      firstId: d.id,
      uzs: 0,
      usd: 0,
    };
    if (d.currency === 'USD') existing.usd = Number((existing.usd + rem).toFixed(2));
    else existing.uzs = Number((existing.uzs + rem).toFixed(2));
    customerMap.set(key, existing);
  }
  const customers = Array.from(customerMap.values()).sort((a, b) => b.uzs - a.uzs || b.usd - a.usd);

  if (isAll) {
    const activeDebtSuppliers = allSuppliers.filter(
      (s) => Math.abs(Number(s.debtUzs)) > 0.001 || Math.abs(Number(s.debtUsd)) > 0.001
    );
    const totalSupUzs = Number(
      allSuppliers.reduce((acc, s) => acc + Number(s.debtUzs || 0), 0).toFixed(2)
    );
    const totalSupUsd = Number(
      allSuppliers.reduce((acc, s) => acc + Number(s.debtUsd || 0), 0).toFixed(2)
    );
    const totalCustUzs = Number(customers.reduce((acc, c) => acc + c.uzs, 0).toFixed(2));
    const totalCustUsd = Number(customers.reduce((acc, c) => acc + c.usd, 0).toFixed(2));

    const lines: string[] = ['📊 **Umumiy qarzlar holati:**', ''];
    lines.push(
      `🏢 **Ta'minotchilarga qarzimiz (${activeDebtSuppliers.length} ta):**`,
      `• UZS: **${formatSom(totalSupUzs)}**`,
      `• USD: **${formatUsd(totalSupUsd, true)}**`
    );
    for (const s of activeDebtSuppliers.slice(0, 5)) {
      const parts: string[] = [];
      if (Math.abs(Number(s.debtUzs)) > 0.001) parts.push(formatSom(s.debtUzs));
      if (Math.abs(Number(s.debtUsd)) > 0.001) parts.push(formatUsd(s.debtUsd));
      lines.push(`  – ${sanitizeMdV1(toLatinUz(s.name))}: ${parts.join(' | ')}`);
    }

    lines.push('');
    lines.push(
      `👥 **Mijozlar nasiyasi (${customers.length} ta):**`,
      `• UZS: **${formatSom(totalCustUzs)}**`,
      `• USD: **${formatUsd(totalCustUsd, true)}**`
    );
    for (const c of customers.slice(0, 5)) {
      const parts: string[] = [];
      if (c.uzs > 0) parts.push(formatSom(c.uzs));
      if (c.usd > 0) parts.push(formatUsd(c.usd));
      lines.push(`  – ${sanitizeMdV1(c.name)}: ${parts.join(' | ')}`);
    }

    const kb = new InlineKeyboard()
      .text("📦 Ta'minotchilar", 'sup:p:1')
      .text('👥 Nasiyadorlar', 'debt:p:1');
    return safeReply(ctx, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
  }

  const normQuery = normalizeForSearch(query);
  const supplierDocs = allSuppliers.map((s) => ({
    ...s,
    latinName: toLatinUz(s.name),
    searchName: normalizeForSearch(s.name),
  }));

  let matchedSuppliers = supplierDocs.filter(
    (s) => s.searchName === normQuery || s.searchName.includes(normQuery) || normQuery.includes(s.searchName)
  );
  if (!matchedSuppliers.length && supplierDocs.length > 0) {
    const fuzzySup = await SupplierService.findOrSuggestSupplier(query, ownerId);
    const direct = fuzzySup.supplier || fuzzySup.suggestedSupplier;
    if (direct) {
      const doc = supplierDocs.find((s) => s.id === direct.id);
      if (doc) matchedSuppliers = [doc];
    }
    if (!matchedSuppliers.length) {
      matchedSuppliers = new Fuse(supplierDocs, {
        keys: ['searchName'],
        threshold: 0.35,
        ignoreLocation: true,
      })
        .search(normQuery)
        .slice(0, 3)
        .map((r) => r.item);
    }
  }
  matchedSuppliers = matchedSuppliers.slice(0, 3);

  let matchedCustomers = customers.filter(
    (c) => c.searchName === normQuery || c.searchName.includes(normQuery) || normQuery.includes(c.searchName)
  );
  if (!matchedCustomers.length && customers.length > 0) {
    matchedCustomers = new Fuse(customers, {
      keys: ['searchName'],
      threshold: 0.35,
      ignoreLocation: true,
    })
      .search(normQuery)
      .slice(0, 3)
      .map((r) => r.item);
  }
  matchedCustomers = matchedCustomers.slice(0, 3);

  if (!matchedSuppliers.length && !matchedCustomers.length) {
    return ctx.reply(`🤷‍♂️ "${query}" bo'yicha ta'minotchi yoki nasiyador topilmadi.`);
  }

  const blocks: string[] = [];
  const kb = new InlineKeyboard();

  for (const sup of matchedSuppliers) {
    const bal = await SupplierService.getSupplierBalance(ownerId, sup.id);
    const uzsLine =
      bal.debtUzs >= 0
        ? `💰 Qarz (UZS): **${formatSom(bal.debtUzs)}**`
        : `🟢 Haqimiz (UZS): **${formatSom(Math.abs(bal.debtUzs))}**`;
    const usdLine =
      bal.debtUsd >= 0
        ? `💵 Qarz (USD): **${formatUsd(bal.debtUsd, true)}**`
        : `🟢 Haqimiz (USD): **${formatUsd(Math.abs(bal.debtUsd), true)}**`;
    blocks.push(
      `🏢 **Ta'minotchi:** ${sanitizeMdV1(sup.latinName)}\n${uzsLine}\n${usdLine}`
    );
    kb.text(`🏢 ${sup.latinName.slice(0, 28)} kartasi`, `sup:v:${sup.id}`).row();
  }

  for (const cust of matchedCustomers) {
    blocks.push(
      `👤 **Mijoz (Nasiya):** ${sanitizeMdV1(cust.name)}\n` +
        `💰 Qarz (UZS): **${formatSom(cust.uzs)}**\n` +
        `💵 Qarz (USD): **${formatUsd(cust.usd, true)}**`
    );
    kb.text(`👤 ${cust.name.slice(0, 28)}`, `debt:v:${cust.firstId}`).row();
  }

  return safeReply(ctx, `📊 **Qarz ma'lumoti:**\n\n${blocks.join('\n\n────────────────\n\n')}`, {
    parse_mode: 'Markdown',
    reply_markup: kb.inline_keyboard.length > 0 ? kb : undefined,
  });
}

async function handleZeroMenuSupplierReturn(ctx: MyContext, ownerId: string, intentData: any) {
  const rawName = toLatinUz(intentData.supplierName || intentData.name || '').trim();
  const amount = Number(Math.abs(Number(intentData.amount || 0)).toFixed(2));
  const currency: 'UZS' | 'USD' = (intentData.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  const note = toLatinUz(String(intentData.note || intentData.comment || '')).trim() || undefined;

  if (!rawName || rawName.length < 2) {
    return ctx.reply("❌ Vozvrat uchun ta'minotchi nomini aniqroq yozing. Masalan: `Milloraga 250 ming yog' vozvrat`", {
      parse_mode: 'Markdown',
    });
  }
  if (!amount || amount <= 0 || isNaN(amount)) {
    return ctx.reply("❌ Vozvrat summasini aniqlab bo'lmadi. Masalan: `Milloraga 250 ming vozvrat`", {
      parse_mode: 'Markdown',
    });
  }
  if (amount > 10_000_000_000) {
    return ctx.reply("❌ Kiritilgan summa o'ta katta (maks: 10 mlrd). Tekshirib qayta yuboring.");
  }

  let targetSupplier: { id: string; name: string } | null = null;
  if (intentData.exactSupplierId && intentData.exactSupplierId !== 'CREATE_NEW') {
    targetSupplier = await prisma.supplier.findFirst({
      where: { id: intentData.exactSupplierId, ownerId },
      select: { id: true, name: true },
    });
  }
  if (!targetSupplier) {
    const fuzzyCheck = await SupplierService.findOrSuggestSupplier(rawName, ownerId);
    const matched = fuzzyCheck.supplier || fuzzyCheck.suggestedSupplier;
    if (matched) {
      targetSupplier = { id: matched.id, name: matched.name };
    }
  }

  if (!targetSupplier) {
    return ctx.reply(
      `🤷‍♂️ "${rawName}" ismli ta'minotchi bazadan topilmadi. Avval ta'minotchi nomini tekshiring yoki 📦 Ta'minotchilar bo'limidan tanlang.`
    );
  }

  const res = await SupplierService.addSupplierReturn(
    ownerId,
    targetSupplier.id,
    amount,
    currency,
    note
  );

  const safeSupName = sanitizeMdV1(toLatinUz(res.supplier.name));
  const noteLine = note ? `📝 Izoh: ${sanitizeMdV1(note)}\n` : '';
  const uzsLine =
    res.balance.debtUzs >= 0
      ? `💰 Joriy qarz (UZS): **${formatSom(res.balance.debtUzs)}**`
      : `🟢 Haqimiz (UZS): **${formatSom(Math.abs(res.balance.debtUzs))}**`;
  const usdLine =
    res.balance.debtUsd >= 0
      ? `💵 Joriy qarz (USD): **${formatUsd(res.balance.debtUsd, true)}**`
      : `🟢 Haqimiz (USD): **${formatUsd(Math.abs(res.balance.debtUsd), true)}**`;

  const kb = new InlineKeyboard()
    .text('🗑 Bekor qilish', `vret:undo:${res.transaction.id}`)
    .text("🏢 Ta'minotchi kartasi", `sup:v:${res.supplier.id}`);

  return safeReply(
    ctx,
    `✅ **Vozvrat (Tovar qaytarish) saqlandi!**\n\n` +
      `🏢 Ta'minotchi: **${safeSupName}**\n` +
      `🔄 Vozvrat summasi: **-${formatCurrency(amount, currency)}**\n` +
      noteLine +
      `_Kassa naqd puliga ta'sir qilmadi._\n\n` +
      `${uzsLine}\n${usdLine}`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
}

async function processIntent(ctx: MyContext, intentData: any) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);

  if (intentData.name) intentData.name = toLatinUz(intentData.name).trim();
  if (intentData.supplierName) intentData.supplierName = toLatinUz(intentData.supplierName).trim();

  if (intentData.intent === 'UNKNOWN')
    return ctx.reply("🤔 Kechirasiz, xabaringizni tushunmadim. Iltimos, aniqroq yozing yoki menyudan tanlang.");
  if (intentData.intent === 'GENERAL_CHAT')
    return ctx.reply(intentData.replyText || 'Savolingizga javob topa olmadim.');
  if (intentData.intent === 'SEARCH_PRODUCT') {
    return handleZeroMenuProductSearch(ctx, ownerId, intentData.name || intentData.supplierName || '');
  }
  if (intentData.intent === 'GET_DEBT_INFO') {
    return handleZeroMenuDebtLookup(ctx, ownerId, intentData.name || intentData.supplierName || 'ALL');
  }
  if (intentData.intent === 'ADD_SUPPLIER_RETURN') {
    return handleZeroMenuSupplierReturn(ctx, ownerId, intentData);
  }

  // Normalize local parser intents into unified voice confirmation intents
  if (intentData.intent === 'INVOICE_CASH') {
    intentData.intent = 'ADD_SUPPLIER_TX';
    intentData.txType = 'INCOMING_GOODS';
    intentData.paymentType = 'CASH';
  } else if (intentData.intent === 'INVOICE_CREDIT') {
    intentData.intent = 'ADD_SUPPLIER_TX';
    intentData.txType = 'INCOMING_GOODS';
    intentData.paymentType = 'CREDIT';
  } else if (intentData.intent === 'SUPPLIER_PAYMENT') {
    intentData.intent = 'ADD_SUPPLIER_TX';
    intentData.txType = 'PAYMENT';
  }

  // MODUL 4: Fuzzy Supplier Typo Guard ("Dinar" vs "Diner" / "Dinar kalbasa")
  if (intentData.intent === 'ADD_SUPPLIER_TX' && !intentData.exactSupplierId) {
    const targetName = intentData.name || intentData.supplierName || '';
    const fuzzyCheck = await SupplierService.findOrSuggestSupplier(targetName, ownerId);

    if (fuzzyCheck.isExactMatch && fuzzyCheck.supplier) {
      intentData.exactSupplierId = fuzzyCheck.supplier.id;
      intentData.name = fuzzyCheck.supplier.name;
    } else if (fuzzyCheck.isFuzzyMatch && fuzzyCheck.suggestedSupplier && fuzzyCheck.promptText) {
      const pendingAction = await prisma.pendingAction.create({
        data: {
          userId: BigInt(ctx.from.id),
          type: 'SUPPLIER_FUZZY_GUARD',
          data: {
            ...intentData,
            ownerId,
            suggestedSupplierId: fuzzyCheck.suggestedSupplier.id,
            suggestedSupplierName: fuzzyCheck.suggestedSupplier.name,
            inputName: fuzzyCheck.inputName,
          } as Prisma.InputJsonValue,
        },
      });
      const kb = getFuzzySupplierSuggestionKeyboard(
        fuzzyCheck.suggestedSupplier.id,
        fuzzyCheck.suggestedSupplier.name,
        fuzzyCheck.inputName,
        pendingAction.id
      );
      return ctx.reply(fuzzyCheck.promptText, { reply_markup: kb });
    } else {
      const candidates = await SupplierService.findMatchingSuppliers(
        targetName,
        intentData.comment,
        ownerId
      );
      if (candidates.length === 1) {
        intentData.exactSupplierId = candidates[0].id;
        intentData.name = candidates[0].name;
      } else if (candidates.length > 1) {
        const candidateIds = candidates.map((c) => c.id);
        const pendingAction = await prisma.pendingAction.create({
          data: {
            userId: BigInt(ctx.from.id),
            type: 'VOICE_INTENT_DISAMBIGUATION',
            data: { ...intentData, ownerId, candidateIds } as Prisma.InputJsonValue,
          },
        });
        return safeReply(
          ctx,
          `⚠️ *Bir nechta ta'minotchi topildi:*\nQaysi "${sanitizeMdV1(intentData.name)}" hisobiga yozilsin?`,
          {
            parse_mode: 'Markdown',
            reply_markup: getDisambiguationKeyboard(candidates, pendingAction.id, 'vsel', 'vnew', 'cancel_vdis'),
          }
        );
      }
    }
  }

  const pendingAction = await prisma.pendingAction.create({
    data: {
      userId: BigInt(ctx.from.id),
      type: 'VOICE_INTENT',
      data: { ...intentData, ownerId } as Prisma.InputJsonValue,
    },
  });
  const actionId = `v_${pendingAction.id}`;
  ctx.session.step = actionId;

  const cur: 'UZS' | 'USD' = (intentData.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  let balancePreview = '';
  if (intentData.intent === 'ADD_SUPPLIER_TX') {
    const isCashPurchase = intentData.paymentType === 'CASH';
    const isIncoming = intentData.txType === 'INCOMING_GOODS';
    const isUsd = cur === 'USD';
    const amt = Number(Math.abs(Number(intentData.amount || 0)).toFixed(2));
    const supp = intentData.exactSupplierId && intentData.exactSupplierId !== 'CREATE_NEW'
      ? await prisma.supplier.findFirst({ where: { id: intentData.exactSupplierId, ownerId }, select: { debtUzs: true, debtUsd: true } })
      : await prisma.supplier.findFirst({
          where: { ownerId, name: { equals: intentData.name, mode: 'insensitive' }, isActive: true },
          select: { debtUzs: true, debtUsd: true },
        });
    if (supp && !isCashPurchase) {
      const curDebt = Number(isUsd ? supp.debtUsd : supp.debtUzs);
      const nextDebt = Number((isIncoming ? curDebt + amt : curDebt - amt).toFixed(2));
      balancePreview = `\n📊 Joriy qarz (${cur}): ${formatCurrency(curDebt, cur)}\n📦 Kutilayotgan yakuniy qoldiq: ${formatCurrency(nextDebt, cur)}`;
    }
  } else if (intentData.intent === 'ADD_CUSTOMER_DEBT') {
    const amt = Number(Math.abs(Number(intentData.amount || 0)).toFixed(2));
    const agg = await prisma.customerDebt.aggregate({
      where: {
        ownerId,
        customerName: { equals: intentData.name, mode: 'insensitive' },
        currency: cur,
        status: { in: ['PENDING', 'PARTIALLY_PAID'] },
      },
      _sum: { amount: true, paidAmount: true },
    });
    const curRem = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);
    const nextRem = Number((curRem + amt).toFixed(2));
    balancePreview = `\n📊 Joriy nasiya (${cur}): ${formatCurrency(curRem, cur)}\n📦 Kutilayotgan yakuniy qoldiq: ${formatCurrency(nextRem, cur)}`;
  }

  const isPaymentTx =
    intentData.intent === 'ADD_SUPPLIER_TX' && intentData.txType === 'PAYMENT';

  const safeParty = sanitizeMdV1(intentData.name || intentData.supplierName || "Noma'lum");
  const safeCategory = sanitizeMdV1(intentData.category || 'Boshqa');
  const safeComment = sanitizeMdV1(intentData.comment || "Yo'q");

  const details =
    intentData.intent === 'ADD_EXPENSE'
      ? `Operatsiya: Xarajat\nSumma: ${formatCurrency(intentData.amount, cur)}\nKategoriya: ${safeCategory}\nIzoh: ${safeComment}`
      : intentData.intent === 'ADD_SUPPLIER_TX' && intentData.paymentType === 'CASH'
      ? `Operatsiya: 💵 Naqd yuk olish (Qarzga qo'shilmaydi)\nTa'minotchi: ${safeParty}\nSumma: ${formatCurrency(Math.abs(Number(intentData.amount)), cur)}`
      : intentData.intent === 'ADD_SUPPLIER_TX'
      ? `Operatsiya: Ta'minotchi bilan oldi-berdi\nTa'minotchi: ${safeParty}\nAmal turi: ${intentData.txType === 'INCOMING_GOODS' ? "Yuk olish (Kirim - Qarzga qo'shish)" : "To'lov (Chiqim - Qarzdan ayirish)"}\nSumma: ${intentData.txType === 'INCOMING_GOODS' ? '+' : '-'}${formatCurrency(Math.abs(Number(intentData.amount)), cur)}${balancePreview}`
      : intentData.intent === 'ADD_CASH_TX'
      ? `Operatsiya: Naqd xarid\nKimdan: ${safeParty}\nSumma: ${formatCurrency(intentData.amount, cur)}`
      : intentData.intent === 'ADD_CUSTOMER_DEBT'
      ? `Operatsiya: Nasiya savdo\nMijoz: ${safeParty}\nSumma: +${formatCurrency(Math.abs(Number(intentData.amount)), cur)}${balancePreview}`
      : '';

  // MODUL 5.2: For supplier payments without an explicit source, ask 1-click payment source
  if (isPaymentTx && !intentData.hasExplicitSource) {
    await safeReply(
      ctx,
      `💸 **Ta'minotchiga to'lov tasdiqlash**\n\n${details}\n\n👇 **Pul qaysi manbadan berildi?**`,
      {
        parse_mode: 'Markdown',
        reply_markup: getPaymentSourceConfirmationKeyboard(actionId),
      }
    );
    return;
  }

  await safeReply(ctx, `⚡️ **Tahlil Natijasi**\n\n${details}\n\nMa'lumotlar to'g'rimi?`, {
    parse_mode: 'Markdown',
    reply_markup: getConfirmationKeyboard(actionId),
  });
}

// MODUL 4: Fuzzy Supplier Typo Guard Callbacks (compact `sf_*` + legacy `sup_fuzzy_*`)
voiceHandler.callbackQuery(/^(?:sf_use:(.+)|sup_fuzzy_use:([^:]+):(.+))$/, async (ctx, next) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const rawPendingId = ctx.match[1] || ctx.match[3];
  if (rawPendingId.startsWith('inv_')) return next();

  const pendingAction = await findOwnedPendingAction(rawPendingId, ctx.from.id);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const pData = pendingAction.data as any;
  const supplierId = ctx.match[2] || pData.suggestedSupplierId;
  const supplier = supplierId
    ? await prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
    : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  await deleteOwnedPendingAction(rawPendingId, ctx.from.id);
  await ctx.deleteMessage().catch(() => {});

  const intentData = {
    ...pData,
    exactSupplierId: supplier.id,
    name: supplier.name,
    supplierName: supplier.name,
  };
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^(?:sf_new|sup_fuzzy_new):(.+)$/, async (ctx, next) => {
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  if (pendingId.startsWith('inv_')) return next();

  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const pData = pendingAction.data as any;
  await deleteOwnedPendingAction(pendingId, ctx.from.id);
  await ctx.deleteMessage().catch(() => {});

  const intentData = {
    ...pData,
    exactSupplierId: 'CREATE_NEW',
    name: toLatinUz(pData.inputName || pData.name),
    supplierName: toLatinUz(pData.inputName || pData.name),
  };
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^(?:sf_no|sup_fuzzy_cancel):(.+)$/, async (ctx, next) => {
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  if (pendingId.startsWith('inv_')) return next();

  await deleteOwnedPendingAction(pendingId, ctx.from.id);
  clearSession(ctx);
  await ctx.editMessageText('❌ Amal bekor qilindi.', { reply_markup: undefined });
});

// MODUL 5.2: 1-Click Payment Source Callbacks (`ps:T:v_<id>` / `ps:S:v_<id>` + legacy)
voiceHandler.callbackQuery(/^(?:pay_source:(TODAY_CASH|PREVIOUS_SAFE)|ps:(T|S)):v_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const paymentSource: 'TODAY_CASH' | 'PREVIOUS_SAFE' =
    ctx.match[1] === 'PREVIOUS_SAFE' || ctx.match[2] === 'S' ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
  const pendingId = ctx.match[3];

  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  const cur: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  const amt = Number(Math.abs(Number(data.amount)).toFixed(2));

  try {
    const finalDebt = await saveSupplierTxData(data, ownerId, paymentSource);
    const sourceBadge =
      paymentSource === 'PREVIOUS_SAFE'
        ? "🏦 Kechagi puldan / Seyfdan (Z-otchyot savdosiga qo'shilmadi)"
        : "💵 Bugungi kassadan (Bugungi Z-otchyotga qo'shildi)";

    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `✅ **To'lov muvaffaqiyatli saqlandi!**\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(toLatinUz(data.name))}**\n` +
          `💸 To'lov: **-${formatCurrency(amt, cur)}**\n` +
          `🗂 Manba: ${sourceBadge}\n` +
          `📊 **Yakuniy qarz qoldig'i (${cur}):** **${formatCurrency(finalDebt, cur)}**`,
        { parse_mode: 'Markdown' }
      );
    }
    await deleteOwnedPendingAction(pendingId, ctx.from.id);
    ctx.session.step = undefined;
  } catch (error) {
    logger.error(error, 'Error saving supplier payment with source');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi.", show_alert: true });
  }
});

voiceHandler.on('message:voice', async (ctx, next) => {
  if (!ctx.user) return next();
  await withChatAction(ctx, 'record_voice', async () => {
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error('Ovozli fayl topilmadi');
      await processIntent(ctx, await AiService.parseVoiceNote(await downloadTelegramFile(file.file_path)));
    } catch (error) {
      logger.error({ error }, 'Error parsing voice');
      await ctx.reply(`❌ Ovozli xabarni tushunib bo'lmadi.\n\nSabab: ${formatFriendlyError(error)}`);
    }
  });
});

voiceHandler.callbackQuery(/^vret:undo:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const txId = ctx.match[1];
  try {
    const res = await SupplierService.deleteSupplierRecord(ownerId, 'VOZVRAT', txId);
    const uzsLine =
      res.balance.debtUzs >= 0
        ? `💰 Joriy qarz (UZS): **${formatSom(res.balance.debtUzs)}**`
        : `🟢 Haqimiz (UZS): **${formatSom(Math.abs(res.balance.debtUzs))}**`;
    const usdLine =
      res.balance.debtUsd >= 0
        ? `💵 Joriy qarz (USD): **${formatUsd(res.balance.debtUsd, true)}**`
        : `🟢 Haqimiz (USD): **${formatUsd(Math.abs(res.balance.debtUsd), true)}**`;

    await ctx.answerCallbackQuery({ text: '🗑 Vozvrat bekor qilindi!' });
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `🗑 **Vozvrat bekor qilindi va balans tiklandi!**\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(toLatinUz(res.supplier.name))}**\n` +
          `↩️ Qaytarilgan summa: ${formatCurrency(res.deletedAmount, res.currency)}\n\n` +
          `${uzsLine}\n${usdLine}`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err: any) {
    await ctx.answerCallbackQuery({
      text: err?.message || 'Ushbu vozvrat topilmadi yoki allaqachon bekor qilingan.',
      show_alert: true,
    });
  }
});

voiceHandler.on('message:text', async (ctx, next) => {
  if (!ctx.user || !ctx.from || ctx.message.text.startsWith('/')) return next();
  const text = ctx.message.text.trim();
  if (isMenuButton(text)) {
    clearSession(ctx);
    return next();
  }

  if (ctx.session.step === 'await_new_supplier_name') {
    const pendingId = ctx.session.tempData?.pendingId;
    const activePending = pendingId
      ? await findOwnedPendingAction(pendingId, ctx.from.id)
      : await prisma.pendingAction.findFirst({
          where: {
            userId: BigInt(ctx.from.id),
            status: 'AWAIT_NEW_SUPPLIER_NAME',
            createdAt: { gte: new Date(Date.now() - 3600000) },
          },
          orderBy: { createdAt: 'desc' },
        });

    if (activePending) {
      const intentData = { ...(activePending.data as any), exactSupplierId: 'CREATE_NEW', name: toLatinUz(text) };
      await deleteOwnedPendingAction(activePending.id, ctx.from.id);
      clearSession(ctx);
      return processIntent(ctx, intentData);
    }
    clearSession(ctx);
  } else if (ctx.session.step) {
    // Earlier handlers already processed text-input steps; leftover confirmation button steps (v_*, i_*, zrep_*) shouldn't block new commands.
    clearSession(ctx);
  }

  // MODUL 2: Instant Local Text Parser (<0.001s, 100% AI-free — never hits AI rate limits!)
  const localParsed = parseTextCommandLocally(text);
  if (localParsed) {
    return processIntent(ctx, localParsed);
  }

  await withChatAction(ctx, 'typing', async () => {
    try {
      await processIntent(ctx, await AiService.parseTextIntent(ctx.message.text));
    } catch (error) {
      logger.error({ error }, 'Error parsing text intent');
      await ctx.reply(
        `🤔 Ushbu matnni tushunib bo'lmadi. Iltimos, quyidagi ko'rinishda yozing:\n` +
          `• Narx so'rash: \`ole narxi\` yoki \`makaron qancha\`\n` +
          `• Qarz so'rash: \`Millora qarz\` yoki \`qarzlarim\`\n` +
          `• Vozvrat: \`Milloraga 250 ming yog' vozvrat\`\n` +
          `• Naqd xarid: \`Sirok 500.000 naqd\`\n` +
          `• Qarzdan to'lov: \`Milter -500.000\``,
        { parse_mode: 'Markdown' }
      );
    }
  });
});

voiceHandler.callbackQuery(/^confirm_v_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT')
    return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  const cur: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  const safeName = sanitizeMdV1(toLatinUz(data.name || "Noma'lum"));
  try {
    let replyMsg = '';
    let useMarkdown = true;

    if (data.intent === 'ADD_EXPENSE') {
      await prisma.expense.create({
        data: {
          ownerId,
          amount: data.amount,
          currency: cur,
          category: toLatinUz(data.category || 'Boshqa'),
          note: toLatinUz(data.comment || ''),
        },
      });
      replyMsg = `✅ Xarajat saqlandi: ${formatCurrency(data.amount, cur)}`;
      useMarkdown = false;
    } else if (data.intent === 'ADD_SUPPLIER_TX') {
      const isCashPurchase = data.paymentType === 'CASH';
      const isIncoming = data.txType === 'INCOMING_GOODS';
      const amt = Number(Math.abs(Number(data.amount)).toFixed(2));
      const finalDebt = await saveSupplierTxData(data, ownerId);

      replyMsg = isCashPurchase
        ? `✅ **Naqd xarid muvaffaqiyatli saqlandi!**\n\n` +
          `🏢 Ta'minotchi: **${safeName}**\n` +
          `💵 Naqd summa: **${formatCurrency(amt, cur)}**\n` +
          `📊 Qarzga qo'shilmadi (0). Bugungi Z-otchyot naqd xaridlariga kiritildi.`
        : `✅ ${isIncoming ? 'Yuk olish (Kirim)' : "To'lov"} muvaffaqiyatli saqlandi!\n\n` +
          `🏢 Ta'minotchi: **${safeName}**\n` +
          `${isIncoming ? '📥 Yangi kirim' : "💸 To'lov"}: **${isIncoming ? '+' : '-'}${formatCurrency(amt, cur)}**\n` +
          `📊 **Yakuniy qarz qoldig'i (${cur}):** **${formatCurrency(finalDebt, cur)}**`;
    } else if (data.intent === 'ADD_CASH_TX') {
      await saveSupplierTxData({ ...data, paymentType: 'CASH' }, ownerId);
      replyMsg = `✅ Naqd xarid saqlandi:\nKimdan: ${safeName}\nSumma: ${formatCurrency(data.amount, cur)}${data.comment ? `\nIzoh: ${sanitizeMdV1(toLatinUz(data.comment))}` : ''}\n_(Ushbu summa qarzga ta'sir qilmadi)_`;
    } else if (data.intent === 'ADD_CUSTOMER_DEBT') {
      const amt = Number(Math.abs(Number(data.amount)).toFixed(2));
      const cleanCust = toLatinUz(data.name);
      await prisma.customerDebt.create({
        data: { ownerId, customerName: cleanCust, amount: amt, currency: cur },
      });
      const agg = await prisma.customerDebt.aggregate({
        where: {
          ownerId,
          customerName: { equals: cleanCust, mode: 'insensitive' },
          currency: cur,
          status: { in: ['PENDING', 'PARTIALLY_PAID'] },
        },
        _sum: { amount: true, paidAmount: true },
      });
      const totalCustRem = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);
      replyMsg =
        `✅ Nasiya muvaffaqiyatli saqlandi!\n\n` +
        `👤 Mijoz: **${sanitizeMdV1(cleanCust)}**\n` +
        `💰 Nasiya summasi: **+${formatCurrency(amt, cur)}**\n` +
        `📊 **Mijozning umumiy nasiya qoldig'i (${cur}):** **${formatCurrency(totalCustRem, cur)}**`;
    }

    await deleteOwnedPendingAction(pendingId, ctx.from.id);
    ctx.session.step = undefined;
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        replyMsg,
        useMarkdown ? { parse_mode: 'Markdown' } : {}
      );
    }
  } catch (error) {
    logger.error(error, 'Transaction error saving voice intent');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi, qayta urinib ko'ring.", show_alert: true });
  }
});

voiceHandler.callbackQuery(/^confirm_suptx_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction || pendingAction.type !== 'SUPPLIER_TX')
    return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  const cur: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  try {
    const isIncoming = data.txType === 'INCOMING_GOODS';
    const amt = Number(Math.abs(Number(data.amount)).toFixed(2));
    const finalDebt = await saveSupplierTxData(data, ownerId);
    await deleteOwnedPendingAction(pendingId, ctx.from.id);
    ctx.session.step = undefined;
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `✅ ${isIncoming ? 'Yuk olish (Kirim)' : "To'lov"} muvaffaqiyatli saqlandi!\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(toLatinUz(data.name))}**\n` +
          `${isIncoming ? '📥 Yangi kirim' : "💸 To'lov"}: **${isIncoming ? '+' : '-'}${formatCurrency(amt, cur)}**\n` +
          `📊 **Yakuniy qarz qoldig'i (${cur}):** **${formatCurrency(finalDebt, cur)}**`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    logger.error(error, 'Error saving supplier tx confirmation');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi.", show_alert: true });
  }
});

voiceHandler.callbackQuery(/^cancel_(?:v|suptx|vdis)_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  await deleteOwnedPendingAction(ctx.match[1], ctx.from.id);
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Bekor qilindi.', { reply_markup: undefined });
});

voiceHandler.callbackQuery(/^vsel_(.+)_(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const [, pendingId, rawIdx] = ctx.match;
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION')
    return ctx.editMessageText(
      '⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.',
      { reply_markup: undefined }
    );
  const pData = pendingAction.data as any;
  const supplierId = pData.candidateIds?.[parseInt(rawIdx, 10)];
  const supplier = supplierId
    ? await prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
    : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
  const intentData = { ...pData, exactSupplierId: supplier.id, name: supplier.name };
  await Promise.all([
    deleteOwnedPendingAction(pendingId, ctx.from.id),
    ctx.deleteMessage().catch(() => {}),
  ]);
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^vnew_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION')
    return ctx.editMessageText(
      '⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.',
      { reply_markup: undefined }
    );
  await prisma.pendingAction.update({
    where: { id: pendingId },
    data: { type: 'VOICE_INTENT_NEW_SUPP', status: 'AWAIT_NEW_SUPPLIER_NAME' },
  });
  ctx.session.step = 'await_new_supplier_name';
  ctx.session.tempData = { pendingId };
  await ctx.editMessageText(NEW_SUPP_PROMPT, { reply_markup: undefined });
});
