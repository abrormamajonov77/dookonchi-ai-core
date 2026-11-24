import crypto from 'node:crypto';
import { User } from '@prisma/client';
import { prisma } from '../database/prisma';
import { invalidateCache, sessionCache } from '../utils/cache';
import { setCachedUser } from './subscription.service';

export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_REGEX =
  /^DOOKON-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export const RECOVERY_MAX_FAILED_ATTEMPTS = 5;
export const RECOVERY_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

export const TARGET_HAS_STORE_DATA_ERROR_UZ =
  "Yangi Telegram akkauntda allaqachon do‘kon ma'lumotlari mavjud. Ma'lumotlar yo‘qolmasligi uchun ko‘chirish to‘xtatildi.";

export type AccountTransferReason = 'ADMIN_TRANSFER' | 'RECOVERY_CODE';

export type AccountRecoveryErrorCode =
  | 'USER_NOT_FOUND'
  | 'INVALID_TELEGRAM_ID'
  | 'SAME_TELEGRAM_ID'
  | 'TARGET_HAS_DATA'
  | 'INVALID_CODE'
  | 'RATE_LIMITED';

export class AccountRecoveryError extends Error {
  public readonly code: AccountRecoveryErrorCode;

  constructor(code: AccountRecoveryErrorCode, message: string) {
    super(message);
    this.name = 'AccountRecoveryError';
    this.code = code;
  }
}

export interface TransferTelegramAccountParams {
  oldUserId: string;
  newTelegramId: string;
  actorTelegramId: string;
  reason: AccountTransferReason;
}

export interface AccountTransferSummary {
  id: string;
  oldTelegramId: string;
  telegramId: string;
  newTelegramId: string;
  fullName: string | null;
  name: string | null;
  phone: string | null;
  username: string | null;
  role: string;
  status: string;
  subscriptionPlan: string | null;
  subscriptionExpiresAt: Date | null;
  deletedEmptyShell: boolean;
  reason: AccountTransferReason;
  user: User;
}

export interface RecoverAccountResult {
  user: User;
  newRecoveryCode: string;
}

interface RecoveryAttemptState {
  failedCount: number;
  windowStartedAt: number;
}

const recoveryFailedAttempts = new Map<string, RecoveryAttemptState>();

function toAuditTelegramId(rawId: string | number | bigint | undefined): bigint {
  const cleaned = String(rawId ?? '').trim();
  if (/^\d+$/.test(cleaned)) {
    return BigInt(cleaned);
  }
  return BigInt(0);
}

/**
 * Normalizes user-entered recovery codes (trims whitespace + uppercases).
 */
export function normalizeRecoveryCode(rawCode: string): string {
  return String(rawCode || '').trim().toUpperCase();
}

/**
 * Computes hex-encoded SHA-256 hash of a normalized recovery code.
 * Plaintext recovery codes are NEVER persisted to the database.
 */
export function hashRecoveryCode(rawCode: string): string {
  const normalized = normalizeRecoveryCode(rawCode);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Generates a cryptographically secure code formatted as `DOOKON-XXXX-XXXX`
 * using the 32-character unambiguous alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
 */
export function buildRandomRecoveryCode(): string {
  const pickBlock = (len: number): string => {
    let block = '';
    for (let i = 0; i < len; i++) {
      const idx = crypto.randomInt(0, RECOVERY_CODE_ALPHABET.length);
      block += RECOVERY_CODE_ALPHABET[idx];
    }
    return block;
  };
  return `DOOKON-${pickBlock(4)}-${pickBlock(4)}`;
}

function sweepExpiredRateLimits(nowMs: number): void {
  if (recoveryFailedAttempts.size < 500) return;
  for (const [key, state] of recoveryFailedAttempts.entries()) {
    if (nowMs - state.windowStartedAt >= RECOVERY_RATE_LIMIT_WINDOW_MS) {
      recoveryFailedAttempts.delete(key);
    }
  }
}

function assertNotRateLimited(newTelegramId: string, nowMs: number = Date.now()): void {
  sweepExpiredRateLimits(nowMs);
  const existing = recoveryFailedAttempts.get(newTelegramId);
  if (!existing) return;

  if (nowMs - existing.windowStartedAt >= RECOVERY_RATE_LIMIT_WINDOW_MS) {
    recoveryFailedAttempts.delete(newTelegramId);
    return;
  }

  if (existing.failedCount >= RECOVERY_MAX_FAILED_ATTEMPTS) {
    const remainingMin = Math.max(
      1,
      Math.ceil((RECOVERY_RATE_LIMIT_WINDOW_MS - (nowMs - existing.windowStartedAt)) / 60_000)
    );
    throw new AccountRecoveryError(
      'RATE_LIMITED',
      `⛔️ Juda ko‘p noto‘g‘ri urinish (${RECOVERY_MAX_FAILED_ATTEMPTS} marta). Xavfsizlik uchun akkauntni tiklash vaqtincha bloklandi. Iltimos, ${remainingMin} daqiqadan so‘ng qayta urinib ko‘ring.`
    );
  }
}

function recordFailedRecoveryAttempt(newTelegramId: string, nowMs: number = Date.now()): void {
  const existing = recoveryFailedAttempts.get(newTelegramId);
  if (!existing || nowMs - existing.windowStartedAt >= RECOVERY_RATE_LIMIT_WINDOW_MS) {
    recoveryFailedAttempts.set(newTelegramId, {
      failedCount: 1,
      windowStartedAt: nowMs,
    });
    return;
  }
  existing.failedCount += 1;
}

/**
 * Resets in-memory recovery rate-limiting state (useful for unit tests).
 */
export function resetRecoveryRateLimiter(telegramId?: string): void {
  if (telegramId !== undefined) {
    recoveryFailedAttempts.delete(String(telegramId).trim());
  } else {
    recoveryFailedAttempts.clear();
  }
}

/**
 * 1. Generates a cryptographically secure `DOOKON-XXXX-XXXX` recovery code,
 * stores ONLY its SHA-256 hash on `User.recoveryCodeHash`, records `RECOVERY_CODE_GENERATED`
 * in `AuditLog`, and returns the plaintext code ONCE.
 */
export async function generateRecoveryCode(userId: string): Promise<string> {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) {
    throw new AccountRecoveryError('USER_NOT_FOUND', 'Foydalanuvchi topilmadi.');
  }

  let existingUser = await prisma.user.findUnique({ where: { id: cleanUserId } });
  if (!existingUser && /^\d+$/.test(cleanUserId)) {
    existingUser = await prisma.user.findUnique({ where: { telegramId: cleanUserId } });
  }
  if (!existingUser) {
    throw new AccountRecoveryError('USER_NOT_FOUND', 'Foydalanuvchi topilmadi.');
  }

  const plainCode = buildRandomRecoveryCode();
  const codeHash = hashRecoveryCode(plainCode);
  const now = new Date();

  const updatedUser = await prisma.user.update({
    where: { id: existingUser.id },
    data: {
      recoveryCodeHash: codeHash,
      recoveryCodeCreatedAt: now,
    },
  });

  await prisma.auditLog.create({
    data: {
      telegramId: toAuditTelegramId(existingUser.telegramId),
      action: 'RECOVERY_CODE_GENERATED',
      details: {
        userId: existingUser.id,
        telegramId: existingUser.telegramId,
        createdAt: now.toISOString(),
      },
    },
  });

  setCachedUser(updatedUser.telegramId, updatedUser);
  return plainCode;
}

/**
 * 2. Safely transfers a store owner's Telegram account inside `prisma.$transaction`,
 * handling empty trial/fresh shell conflicts, blocking overwrites when target already
 * owns real store data, migrating multi-tenant `ownerId` references, and logging to `AuditLog`.
 */
export async function transferTelegramAccount(
  params: TransferTelegramAccountParams
): Promise<AccountTransferSummary> {
  const cleanOldUserId = String(params.oldUserId || '').trim();
  const cleanNewTelegramId = String(params.newTelegramId || '').trim();
  const cleanActorTelegramId = String(params.actorTelegramId || '').trim();

  if (!cleanOldUserId) {
    throw new AccountRecoveryError('USER_NOT_FOUND', 'Ko‘chiriladigan foydalanuvchi topilmadi.');
  }
  if (!cleanNewTelegramId || !/^\d+$/.test(cleanNewTelegramId)) {
    throw new AccountRecoveryError(
      'INVALID_TELEGRAM_ID',
      'Yangi Telegram ID faqat raqamlardan iborat bo‘lishi kerak.'
    );
  }

  const txResult = await prisma.$transaction(
    async (tx) => {
      let oldUser = await tx.user.findUnique({ where: { id: cleanOldUserId } });
      if (!oldUser && /^\d+$/.test(cleanOldUserId)) {
        oldUser = await tx.user.findUnique({ where: { telegramId: cleanOldUserId } });
      }
      if (!oldUser) {
        throw new AccountRecoveryError(
          'USER_NOT_FOUND',
          'Ko‘chiriladigan foydalanuvchi topilmadi.'
        );
      }

      const oldTelegramId = String(oldUser.telegramId).trim();
      if (oldTelegramId === cleanNewTelegramId) {
        throw new AccountRecoveryError(
          'SAME_TELEGRAM_ID',
          'Yangi Telegram ID eski Telegram ID bilan bir xil bo‘lishi mumkin emas.'
        );
      }

      // Safe Conflict Handling: inspect whether newTelegramId already has a User row or real store data
      const existingTargetUser = await tx.user.findUnique({
        where: { telegramId: cleanNewTelegramId },
      });

      const targetOwnerKeys = Array.from(
        new Set([cleanNewTelegramId, existingTargetUser?.id].filter((v): v is string => Boolean(v)))
      );

      const [
        invoicesCount,
        supplierPaymentsCount,
        supplierTransactionsCount,
        expensesCount,
        cashTransactionsCount,
        zReportsCount,
        customerDebtsCount,
        suppliersCount,
      ] = await Promise.all([
        tx.invoice.count({ where: { ownerId: { in: targetOwnerKeys } } }),
        tx.supplierPayment.count({ where: { ownerId: { in: targetOwnerKeys } } }),
        tx.supplierTransaction.count({ where: { ownerId: { in: targetOwnerKeys } } }),
        tx.expense.count({ where: { ownerId: { in: targetOwnerKeys } } }),
        tx.cashTransaction.count({ where: { ownerId: { in: targetOwnerKeys } } }),
        tx.zReport.count({ where: { ownerId: { in: targetOwnerKeys } } }),
        tx.customerDebt.count({ where: { ownerId: { in: targetOwnerKeys } } }),
        tx.supplier.count({ where: { ownerId: { in: targetOwnerKeys } } }),
      ]);

      const totalTargetStoreRecords =
        invoicesCount +
        supplierPaymentsCount +
        supplierTransactionsCount +
        expensesCount +
        cashTransactionsCount +
        zReportsCount +
        customerDebtsCount +
        suppliersCount;

      if (totalTargetStoreRecords > 0) {
        throw new AccountRecoveryError('TARGET_HAS_DATA', TARGET_HAS_STORE_DATA_ERROR_UZ);
      }

      let deletedEmptyShell = false;
      if (existingTargetUser) {
        // Target is an empty fresh/trial shell -> clean any empty register/product shells and delete shell user
        if (tx.dailyRegister?.deleteMany) {
          await tx.dailyRegister.deleteMany({ where: { ownerId: { in: targetOwnerKeys } } });
        }
        if (tx.product?.deleteMany) {
          await tx.product.deleteMany({ where: { ownerId: { in: targetOwnerKeys } } });
        }
        await tx.user.delete({ where: { id: existingTargetUser.id } });
        deletedEmptyShell = true;
      }

      // Update oldUser.telegramId -> newTelegramId while preserving id, subscription status, and expiry
      const updatedUser = await tx.user.update({
        where: { id: oldUser.id },
        data: {
          telegramId: cleanNewTelegramId,
        },
      });

      // Migrate multi-tenant store data keyed by ownerId === oldTelegramId so 100% of store history stays intact
      if (tx.supplier?.updateMany) {
        await tx.supplier.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.product?.updateMany) {
        await tx.product.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.invoice?.updateMany) {
        await tx.invoice.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.invoiceItem?.updateMany) {
        await tx.invoiceItem.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.supplierPayment?.updateMany) {
        await tx.supplierPayment.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.supplierTransaction?.updateMany) {
        await tx.supplierTransaction.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.customerDebt?.updateMany) {
        await tx.customerDebt.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.expense?.updateMany) {
        await tx.expense.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.cashTransaction?.updateMany) {
        await tx.cashTransaction.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.dailyRegister?.updateMany) {
        await tx.dailyRegister.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.zReport?.updateMany) {
        await tx.zReport.updateMany({
          where: { ownerId: oldTelegramId },
          data: { ownerId: cleanNewTelegramId },
        });
      }
      if (tx.subscriptionPayment?.updateMany) {
        await tx.subscriptionPayment.updateMany({
          where: { userTelegramId: oldTelegramId },
          data: { userTelegramId: cleanNewTelegramId },
        });
      }
      if (tx.pendingAction?.updateMany && /^\d+$/.test(oldTelegramId)) {
        await tx.pendingAction.updateMany({
          where: { userId: BigInt(oldTelegramId) },
          data: { userId: BigInt(cleanNewTelegramId) },
        });
      }

      const auditAction =
        params.reason === 'ADMIN_TRANSFER' ? 'ACCOUNT_TRANSFERRED' : 'ACCOUNT_RECOVERED';

      await tx.auditLog.create({
        data: {
          telegramId: toAuditTelegramId(cleanActorTelegramId || cleanNewTelegramId),
          action: auditAction,
          details: {
            userId: updatedUser.id,
            oldTelegramId,
            newTelegramId: cleanNewTelegramId,
            actorTelegramId: cleanActorTelegramId,
            reason: params.reason,
            deletedEmptyShellUserId: existingTargetUser?.id ?? null,
          },
        },
      });

      return {
        updatedUser,
        oldTelegramId,
        deletedEmptyShell,
      };
    },
    { maxWait: 15000, timeout: 30000 }
  );

  invalidateCache(txResult.oldTelegramId);
  invalidateCache(cleanNewTelegramId);
  sessionCache.delete(txResult.oldTelegramId);
  sessionCache.delete(cleanNewTelegramId);
  setCachedUser(cleanNewTelegramId, txResult.updatedUser);

  const u = txResult.updatedUser;
  return {
    id: u.id,
    oldTelegramId: txResult.oldTelegramId,
    telegramId: u.telegramId,
    newTelegramId: cleanNewTelegramId,
    fullName: u.fullName,
    name: u.name,
    phone: u.phone,
    username: u.username,
    role: u.role,
    status: u.status,
    subscriptionPlan: u.subscriptionPlan,
    subscriptionExpiresAt: u.subscriptionExpiresAt,
    deletedEmptyShell: txResult.deletedEmptyShell,
    reason: params.reason,
    user: u,
  };
}

/**
 * 3. Self-service one-time recovery code redemption with in-memory rate limiting
 * (max 5 failed attempts per `newTelegramId` per 60 minutes) and automatic code rotation.
 */
export async function recoverAccountByCode(
  newTelegramId: string,
  rawCode: string,
  nowMs: number = Date.now()
): Promise<RecoverAccountResult> {
  const cleanNewTelegramId = String(newTelegramId || '').trim();
  if (!cleanNewTelegramId || !/^\d+$/.test(cleanNewTelegramId)) {
    throw new AccountRecoveryError(
      'INVALID_TELEGRAM_ID',
      'Yangi Telegram ID faqat raqamlardan iborat bo‘lishi kerak.'
    );
  }

  assertNotRateLimited(cleanNewTelegramId, nowMs);

  const normalizedCode = normalizeRecoveryCode(rawCode);
  if (!normalizedCode) {
    recordFailedRecoveryAttempt(cleanNewTelegramId, nowMs);
    throw new AccountRecoveryError(
      'INVALID_CODE',
      '❌ Tiklash kaliti kiritilmadi yoki noto‘g‘ri. Misol: /tiklash DOOKON-XXXX-XXXX'
    );
  }

  const codeHash = hashRecoveryCode(normalizedCode);
  const matchedUser = await prisma.user.findUnique({
    where: { recoveryCodeHash: codeHash },
  });

  if (!matchedUser) {
    recordFailedRecoveryAttempt(cleanNewTelegramId, nowMs);
    throw new AccountRecoveryError(
      'INVALID_CODE',
      '❌ Tiklash kaliti noto‘g‘ri yoki allaqachon ishlatilgan. Kalitni tekshirib qayta urinib ko‘ring.'
    );
  }

  const transferSummary = await transferTelegramAccount({
    oldUserId: matchedUser.id,
    newTelegramId: cleanNewTelegramId,
    actorTelegramId: cleanNewTelegramId,
    reason: 'RECOVERY_CODE',
  });

  // Immediately rotate recovery code so the redeemed code is permanently invalidated
  const newRecoveryCode = await generateRecoveryCode(transferSummary.id);

  recoveryFailedAttempts.delete(cleanNewTelegramId);

  const refreshedUser =
    (await prisma.user.findUnique({ where: { id: transferSummary.id } })) ??
    transferSummary.user;

  setCachedUser(cleanNewTelegramId, refreshedUser);

  return {
    user: refreshedUser,
    newRecoveryCode,
  };
}

export const AccountRecoveryService = {
  generateRecoveryCode,
  transferTelegramAccount,
  recoverAccountByCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  resetRecoveryRateLimiter,
};
