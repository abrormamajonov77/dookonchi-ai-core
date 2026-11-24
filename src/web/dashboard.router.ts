import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Bot, InputFile } from 'grammy';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../database/prisma';
import { MyContext } from '../bot/context';
import { isSuperAdmin } from '../utils/admin';
import {
  formatTashkentDateIso,
  formatTashkentYearMonth,
  getDailyTimeMachine,
  getExpenseAnalysisAndAnomalies,
  getMonthlyComparison,
  getPreviousYearMonth,
  getRestockCyclesAndPaymentCalendar,
  getSupplierDebtMap,
} from '../services/dashboard.service';
import {
  getSupplierBalance,
  getSupplierRecordsPaginated,
} from '../services/supplier.service';
import { ExportService } from '../services/export.service';
import { toLatinUz } from '../utils/transliterate';

export interface VerifiedTelegramWebAppUser {
  telegramId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  username: string | null;
  authDate: number;
}

export type VerifyInitDataResult =
  | { ok: true; user: VerifiedTelegramWebAppUser }
  | { ok: false; error: string };

/**
 * Official Telegram WebApp initData HMAC-SHA256 verification.
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramWebAppInitData(
  initData: string,
  botToken: string,
  options?: { maxAgeSeconds?: number; nowUnixSeconds?: number }
): VerifyInitDataResult {
  const raw = String(initData || '').trim();
  if (!raw) {
    return { ok: false, error: 'Missing X-Telegram-Init-Data header' };
  }
  if (!botToken) {
    return { ok: false, error: 'Missing BOT_TOKEN configuration' };
  }

  const params = new URLSearchParams(raw);
  const providedHash = params.get('hash');
  if (!providedHash || !/^[0-9a-fA-F]{64}$/.test(providedHash)) {
    return { ok: false, error: 'Invalid or missing initData hash' };
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      pairs.push(`${key}=${value}`);
    }
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const providedBuf = Buffer.from(providedHash.toLowerCase(), 'hex');
  const expectedBuf = Buffer.from(expectedHash.toLowerCase(), 'hex');
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, error: 'Invalid Telegram WebApp signature' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  const maxAgeSeconds = options?.maxAgeSeconds ?? 86400;
  const nowUnixSeconds = options?.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (!authDate || nowUnixSeconds - authDate > maxAgeSeconds) {
    return { ok: false, error: 'Telegram WebApp session expired' };
  }

  const userJson = params.get('user');
  if (!userJson) {
    return { ok: false, error: 'Missing user payload in initData' };
  }

  try {
    const parsed = JSON.parse(userJson);
    if (!parsed || (typeof parsed.id !== 'number' && typeof parsed.id !== 'string')) {
      return { ok: false, error: 'Invalid user.id in initData' };
    }
    const firstName = String(parsed.first_name || '').trim();
    const lastName = String(parsed.last_name || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || "Do'kon egasi";

    return {
      ok: true,
      user: {
        telegramId: String(parsed.id).trim(),
        firstName,
        lastName,
        fullName,
        username: parsed.username ? String(parsed.username) : null,
        authDate,
      },
    };
  } catch {
    return { ok: false, error: 'Malformed user JSON in initData' };
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function resolveDashboardHtml(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), 'public', 'dashboard', 'index.html'),
    path.resolve(__dirname, '..', '..', 'public', 'dashboard', 'index.html'),
  ];
  for (const filePath of candidates) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {}
  }
  throw new Error('Dashboard HTML asset not found (public/dashboard/index.html)');
}

async function authenticateDashboardRequest(req: http.IncomingMessage): Promise<
  | { ok: true; ownerId: string; userName: string; role: string }
  | { ok: false; statusCode: number; error: string }
> {
  const rawHeader = req.headers['x-telegram-init-data'];
  const initData = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader || '';

  const verified = verifyTelegramWebAppInitData(initData, env.BOT_TOKEN);
  if (!verified.ok) {
    return { ok: false, statusCode: 401, error: verified.error };
  }

  const telegramId = verified.user.telegramId;
  const isSuper = isSuperAdmin(telegramId);

  const dbUser = await prisma.user.findUnique({ where: { telegramId } });

  if (isSuper) {
    return {
      ok: true,
      ownerId: telegramId,
      userName: dbUser?.fullName || dbUser?.name || verified.user.fullName,
      role: 'SUPER_ADMIN',
    };
  }

  if (!dbUser) {
    return { ok: false, statusCode: 403, error: "Avval botda /start orqali ro'yxatdan o'ting." };
  }

  if (dbUser.status === 'BLOCKED') {
    return { ok: false, statusCode: 403, error: 'Hisobingiz bloklangan.' };
  }
  if (dbUser.status === 'PAUSED') {
    return { ok: false, statusCode: 403, error: "Obunangiz vaqtincha to'xtatilgan." };
  }
  if (
    dbUser.status !== 'ACTIVE' ||
    (dbUser.subscriptionExpiresAt && new Date() > new Date(dbUser.subscriptionExpiresAt))
  ) {
    return { ok: false, statusCode: 403, error: 'Obuna muddatingiz yakunlangan.' };
  }

  const allowedRoles = new Set(['OWNER', 'STORE_OWNER', 'SUPER_ADMIN']);
  if (!allowedRoles.has(dbUser.role)) {
    return { ok: false, statusCode: 403, error: "Dashboardga kirish uchun ruxsat yo'q." };
  }

  return {
    ok: true,
    ownerId: telegramId,
    userName: dbUser.fullName || dbUser.name || verified.user.fullName,
    role: dbUser.role,
  };
}

/**
 * Handles Dashboard HTML and /api/dashboard/* routes on the existing HTTP server.
 * Returns true if the request was handled, false otherwise (so /health stays untouched).
 */
export async function handleDashboardHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bot: Bot<MyContext>
): Promise<boolean> {
  const fullUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = fullUrl.pathname;
  const method = (req.method || 'GET').toUpperCase();

  // 1. Static single-page CEO Dashboard HTML
  if (pathname === '/dashboard' || pathname === '/dashboard/') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return true;
    }
    try {
      const html = await resolveDashboardHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      if (method === 'HEAD') {
        res.end();
      } else {
        res.end(html);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to serve dashboard HTML');
      sendJson(res, 500, { error: 'Dashboard sahifasi yuklanmadi' });
    }
    return true;
  }

  // Only handle /api/dashboard/* from here on
  if (!pathname.startsWith('/api/dashboard/')) {
    return false;
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
    });
    res.end();
    return true;
  }

  // Authenticate Telegram WebApp user & resolve multi-tenant ownerId
  const auth = await authenticateDashboardRequest(req);
  if (!auth.ok) {
    sendJson(res, auth.statusCode, { error: auth.error });
    return true;
  }

  const { ownerId, userName, role } = auth;

  try {
    // GET /api/dashboard/overview?monthA=YYYY-MM&monthB=YYYY-MM
    if (method === 'GET' && pathname === '/api/dashboard/overview') {
      const defaultMonthA = formatTashkentYearMonth();
      const monthA = fullUrl.searchParams.get('monthA') || defaultMonthA;
      const monthB = fullUrl.searchParams.get('monthB') || getPreviousYearMonth(monthA);

      const [monthlyComparison, supplierDebtMap] = await Promise.all([
        getMonthlyComparison(ownerId, monthA, monthB),
        getSupplierDebtMap(ownerId),
      ]);

      sendJson(res, 200, {
        user: { name: userName, role },
        monthlyComparison,
        supplierDebtMap,
      });
      return true;
    }

    // GET /api/dashboard/daily?dateA=YYYY-MM-DD&dateB=YYYY-MM-DD
    if (method === 'GET' && pathname === '/api/dashboard/daily') {
      const dateA = fullUrl.searchParams.get('dateA') || formatTashkentDateIso();
      const dateB = fullUrl.searchParams.get('dateB') || undefined;
      const data = await getDailyTimeMachine(ownerId, dateA, dateB);
      sendJson(res, 200, data);
      return true;
    }

    // GET /api/dashboard/expenses?monthA=YYYY-MM&monthB=YYYY-MM
    if (method === 'GET' && pathname === '/api/dashboard/expenses') {
      const defaultMonthA = formatTashkentYearMonth();
      const monthA = fullUrl.searchParams.get('monthA') || defaultMonthA;
      const monthB = fullUrl.searchParams.get('monthB') || getPreviousYearMonth(monthA);
      const data = await getExpenseAnalysisAndAnomalies(ownerId, monthA, monthB);
      sendJson(res, 200, data);
      return true;
    }

    // GET /api/dashboard/cycles
    if (method === 'GET' && pathname === '/api/dashboard/cycles') {
      const data = await getRestockCyclesAndPaymentCalendar(ownerId);
      sendJson(res, 200, data);
      return true;
    }

    // POST /api/dashboard/supplier/:id/send-pdf
    const pdfMatch = pathname.match(/^\/api\/dashboard\/supplier\/([^/]+)\/send-pdf$/);
    if (method === 'POST' && pdfMatch) {
      const supplierId = decodeURIComponent(pdfMatch[1]);
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplierId, ownerId },
        select: { id: true, name: true },
      });
      if (!supplier) {
        sendJson(res, 404, { error: "Ta'minotchi topilmadi yoki ruxsat yo'q." });
        return true;
      }

      const { buffer, filename } = await ExportService.generateSupplierHistoryPdf(ownerId, supplierId);
      await bot.api.sendDocument(ownerId, new InputFile(buffer, filename), {
        caption: `📄 ${toLatinUz(supplier.name)} — To'liq hisob-kitob tarixi (Sverka)`,
      });

      sendJson(res, 200, { ok: true, filename, supplierName: toLatinUz(supplier.name) });
      return true;
    }

    // GET /api/dashboard/supplier/:id
    const supMatch = pathname.match(/^\/api\/dashboard\/supplier\/([^/]+)$/);
    if (method === 'GET' && supMatch) {
      const supplierId = decodeURIComponent(supMatch[1]);
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplierId, ownerId },
        select: { id: true, name: true, phone: true },
      });
      if (!supplier) {
        sendJson(res, 404, { error: "Ta'minotchi topilmadi yoki ruxsat yo'q." });
        return true;
      }

      const [balance, cheklar, pullar, vozvrat] = await Promise.all([
        getSupplierBalance(ownerId, supplierId),
        getSupplierRecordsPaginated(ownerId, supplierId, 'CHEKLAR', 1, 10),
        getSupplierRecordsPaginated(ownerId, supplierId, 'PULLAR', 1, 10),
        getSupplierRecordsPaginated(ownerId, supplierId, 'VOZVRAT', 1, 10),
      ]);

      sendJson(res, 200, {
        supplier: {
          id: supplier.id,
          name: toLatinUz(supplier.name),
          phone: supplier.phone,
        },
        balance,
        cheklar,
        pullar,
        vozvrat,
      });
      return true;
    }

    sendJson(res, 404, { error: 'Not Found' });
    return true;
  } catch (err: any) {
    logger.error({ err, pathname, ownerId }, 'Dashboard API error');
    sendJson(res, 500, { error: "Ma'lumotlarni yuklashda xatolik yuz berdi." });
    return true;
  }
}
