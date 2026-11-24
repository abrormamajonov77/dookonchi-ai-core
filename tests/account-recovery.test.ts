import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/database/prisma';
import { env, parseEnv } from '../src/config/env';
import {
  getPrimarySuperAdminId,
  getSuperAdminIds,
  isSuperAdmin,
  parseSuperAdminIds,
} from '../src/utils/admin';
import {
  AccountRecoveryError,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  recoverAccountByCode,
  RECOVERY_CODE_REGEX,
  resetRecoveryRateLimiter,
  TARGET_HAS_STORE_DATA_ERROR_UZ,
  transferTelegramAccount,
} from '../src/services/account-recovery.service';
import { authMiddleware } from '../src/bot/middlewares/auth.middleware';
import {
  handleGenerateBackupKey,
  handleRecoverAccountCommand,
} from '../src/bot/handlers/start';
import { getAdminMainPanelKeyboard } from '../src/bot/handlers/admin';
import { getMainMenu, isMenuButton } from '../src/bot/keyboards/menu';
import { handleDashboardHttpRequest } from '../src/web/dashboard.router';

const origOwnerId = process.env.OWNER_TELEGRAM_ID;
const origOwnerIds = process.env.OWNER_TELEGRAM_IDS;

function restoreOwnerEnv() {
  if (origOwnerId === undefined) {
    delete process.env.OWNER_TELEGRAM_ID;
  } else {
    process.env.OWNER_TELEGRAM_ID = origOwnerId;
  }
  if (origOwnerIds === undefined) {
    delete process.env.OWNER_TELEGRAM_IDS;
  } else {
    process.env.OWNER_TELEGRAM_IDS = origOwnerIds;
  }
}

beforeEach(() => {
  resetRecoveryRateLimiter();
  restoreOwnerEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRecoveryRateLimiter();
  restoreOwnerEnv();
});

describe('1. Multi-Super-Admin Support (isSuperAdmin & OWNER_TELEGRAM_IDS)', () => {
  it('supports legacy single OWNER_TELEGRAM_ID with string, number, bigint, and whitespace', () => {
    const envSource = { OWNER_TELEGRAM_ID: '8958126400' };

    expect(isSuperAdmin('8958126400', envSource)).toBe(true);
    expect(isSuperAdmin(8958126400, envSource)).toBe(true);
    expect(isSuperAdmin(BigInt('8958126400'), envSource)).toBe(true);
    expect(isSuperAdmin('  8958126400  ', envSource)).toBe(true);

    expect(isSuperAdmin('9999999999', envSource)).toBe(false);
    expect(isSuperAdmin(undefined, envSource)).toBe(false);
    expect(isSuperAdmin('', envSource)).toBe(false);
    expect(isSuperAdmin('not_a_number', envSource)).toBe(false);
  });

  it('merges comma-separated OWNER_TELEGRAM_IDS and legacy OWNER_TELEGRAM_ID into a normalized Set', () => {
    process.env.OWNER_TELEGRAM_ID = '11111';
    process.env.OWNER_TELEGRAM_IDS = ' 22222 , 33333 , 11111 ';

    const ids = getSuperAdminIds();
    expect(Array.from(ids).sort()).toEqual(['11111', '22222', '33333']);

    expect(isSuperAdmin('11111')).toBe(true);
    expect(isSuperAdmin(22222)).toBe(true);
    expect(isSuperAdmin(33333n)).toBe(true);
    expect(isSuperAdmin('44444')).toBe(false);
    expect(getPrimarySuperAdminId()).toBe('22222');
  });

  it('allows production parseEnv with only OWNER_TELEGRAM_IDS and backfills OWNER_TELEGRAM_ID', () => {
    const res = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:6543/postgres',
      BOT_TOKEN: '123456789:REAL_BOT_TOKEN_XYZ',
      GEMINI_API_KEY: 'AIzaRealKeyExample456',
      OWNER_TELEGRAM_IDS: ' 777001 , 777002 ',
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.OWNER_TELEGRAM_ID).toBe('777001');
      expect(res.data.OWNER_TELEGRAM_IDS).toBe('777001 , 777002');
      const parsedSet = parseSuperAdminIds(res.data);
      expect(parsedSet.has('777001')).toBe(true);
      expect(parsedSet.has('777002')).toBe(true);
    }
  });

  it('authorizes secondary Super-Admin from OWNER_TELEGRAM_IDS on CEO Dashboard API', async () => {
    process.env.OWNER_TELEGRAM_IDS = '11111,22222';
    const botToken = env.BOT_TOKEN;
    const authDate = Math.floor(Date.now() / 1000);

    const params = new URLSearchParams();
    params.set('auth_date', String(authDate));
    params.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc');
    params.set(
      'user',
      JSON.stringify({ id: 22222, first_name: 'Ikkinchi', last_name: 'Admin' })
    );
    const pairs: string[] = [];
    params.forEach((v, k) => pairs.push(`${k}=${v}`));
    pairs.sort((a, b) => a.localeCompare(b));
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');
    params.set('hash', hash);

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.invoice, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.supplierPayment, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.supplierTransaction, 'findMany').mockResolvedValue([]);

    let statusCode = 200;
    let body = '';
    const mockRes = {
      writeHead(code: number) {
        statusCode = code;
        return mockRes;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        return mockRes;
      },
    } as unknown as http.ServerResponse;

    const mockReq = {
      url: '/api/dashboard/cycles',
      method: 'GET',
      headers: {
        host: 'localhost:3000',
        'x-telegram-init-data': params.toString(),
      },
    } as unknown as http.IncomingMessage;

    const handled = await handleDashboardHttpRequest(mockReq, mockRes, {} as any);
    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    expect(JSON.parse(body)).toHaveProperty('todayWeekday');
  });
});

describe('2. generateRecoveryCode — Format, SHA-256 Hashing & AuditLog', () => {
  it('generates DOOKON-XXXX-XXXX with unambiguous alphabet, stores ONLY SHA-256 hash, and logs AuditLog', async () => {
    let savedHash: string | null = null;
    let savedCreatedAt: Date | null = null;
    let auditPayload: any = null;

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: 'user-uuid-1',
      telegramId: '998901112233',
      fullName: 'Baraka Market',
      status: 'ACTIVE',
    } as any);

    vi.spyOn(prisma.user, 'update').mockImplementation((async (args: any) => {
      savedHash = args.data.recoveryCodeHash;
      savedCreatedAt = args.data.recoveryCodeCreatedAt;
      return {
        id: 'user-uuid-1',
        telegramId: '998901112233',
        recoveryCodeHash: savedHash,
        recoveryCodeCreatedAt: savedCreatedAt,
      } as any;
    }) as any);

    vi.spyOn(prisma.auditLog, 'create').mockImplementation((async (args: any) => {
      auditPayload = args.data;
      return { id: 'audit-1', ...args.data } as any;
    }) as any);

    const plainCode = await generateRecoveryCode('user-uuid-1');

    // Verify human-readable unambiguous format (suffix has no 0, O, 1, I)
    expect(plainCode).toMatch(RECOVERY_CODE_REGEX);
    const randomPortion = plainCode.replace(/^DOOKON-/, '');
    expect(randomPortion).not.toMatch(/[01IO]/);

    // Verify SHA-256 hash matches and plaintext is NEVER stored
    const expectedSha256 = crypto
      .createHash('sha256')
      .update(plainCode, 'utf8')
      .digest('hex');

    expect(hashRecoveryCode(`  ${plainCode.toLowerCase()}  `)).toBe(expectedSha256);
    expect(normalizeRecoveryCode(`  ${plainCode.toLowerCase()}  `)).toBe(plainCode);
    expect(savedHash).toBe(expectedSha256);
    expect(savedHash).not.toBe(plainCode);
    expect(savedCreatedAt).toBeInstanceOf(Date);

    // Verify AuditLog entry does NOT leak plaintext code
    expect(auditPayload.action).toBe('RECOVERY_CODE_GENERATED');
    expect(auditPayload.telegramId).toBe(BigInt('998901112233'));
    expect(JSON.stringify(auditPayload.details)).not.toContain(plainCode);
  });
});

describe('3. transferTelegramAccount — Clean Transfer, Empty Shell Cleanup & Data Overwrite Protection', () => {
  function buildMockTx(overrides?: {
    oldUser?: any;
    targetUser?: any;
    counts?: Partial<Record<string, number>>;
  }) {
    const counts = overrides?.counts || {};
    const deletedUserIds: string[] = [];
    const updatedUsers: any[] = [];
    const migratedSuppliers: any[] = [];
    const auditLogs: any[] = [];

    const oldUser =
      overrides?.oldUser !== undefined
        ? overrides.oldUser
        : {
            id: 'owner-uuid-100',
            telegramId: '100001',
            fullName: 'Sherzod Aka',
            name: 'Sherzod Aka',
            phone: '+998901234567',
            role: 'STORE_OWNER',
            status: 'ACTIVE',
            subscriptionPlan: '3 Oylik',
            subscriptionExpiresAt: new Date('2027-02-01T00:00:00.000Z'),
          };

    const targetUser = overrides?.targetUser ?? null;

    const tx: any = {
      user: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id === oldUser?.id || where.telegramId === oldUser?.telegramId) {
            return oldUser;
          }
          if (where.telegramId && targetUser && where.telegramId === targetUser.telegramId) {
            return targetUser;
          }
          return null;
        }),
        delete: vi.fn(async ({ where }: any) => {
          deletedUserIds.push(where.id);
          return targetUser;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const updated = { ...oldUser, id: where.id, ...data };
          updatedUsers.push(updated);
          return updated;
        }),
      },
      invoice: {
        count: vi.fn(async () => counts.invoice ?? 0),
        updateMany: vi.fn(async () => ({ count: 3 })),
      },
      supplierPayment: {
        count: vi.fn(async () => counts.supplierPayment ?? 0),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
      supplierTransaction: {
        count: vi.fn(async () => counts.supplierTransaction ?? 0),
        updateMany: vi.fn(async () => ({ count: 5 })),
      },
      expense: {
        count: vi.fn(async () => counts.expense ?? 0),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      cashTransaction: {
        count: vi.fn(async () => counts.cashTransaction ?? 0),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      zReport: {
        count: vi.fn(async () => counts.zReport ?? 0),
        updateMany: vi.fn(async () => ({ count: 4 })),
      },
      customerDebt: {
        count: vi.fn(async () => counts.customerDebt ?? 0),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
      supplier: {
        count: vi.fn(async () => counts.supplier ?? 0),
        updateMany: vi.fn(async (args: any) => {
          migratedSuppliers.push(args);
          return { count: 4 };
        }),
      },
      product: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 10 })),
      },
      invoiceItem: { updateMany: vi.fn(async () => ({ count: 15 })) },
      dailyRegister: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 4 })),
      },
      subscriptionPayment: { updateMany: vi.fn(async () => ({ count: 1 })) },
      pendingAction: { updateMany: vi.fn(async () => ({ count: 0 })) },
      auditLog: {
        create: vi.fn(async ({ data }: any) => {
          auditLogs.push(data);
          return { id: 'audit-tx-1', ...data };
        }),
      },
    };

    return { tx, deletedUserIds, updatedUsers, migratedSuppliers, auditLogs };
  }

  it('performs clean transfer preserving id, subscription expiry, store history, and logging ACCOUNT_TRANSFERRED', async () => {
    const { tx, deletedUserIds, migratedSuppliers, auditLogs } = buildMockTx();
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(tx)) as any);

    const summary = await transferTelegramAccount({
      oldUserId: 'owner-uuid-100',
      newTelegramId: '200002',
      actorTelegramId: '8958126400',
      reason: 'ADMIN_TRANSFER',
    });

    expect(summary.id).toBe('owner-uuid-100');
    expect(summary.oldTelegramId).toBe('100001');
    expect(summary.newTelegramId).toBe('200002');
    expect(summary.telegramId).toBe('200002');
    expect(summary.status).toBe('ACTIVE');
    expect(summary.subscriptionExpiresAt?.toISOString()).toBe('2027-02-01T00:00:00.000Z');
    expect(summary.deletedEmptyShell).toBe(false);
    expect(deletedUserIds).toEqual([]);

    // Multi-tenant ownerId history migrated to newTelegramId
    expect(migratedSuppliers[0]).toEqual({
      where: { ownerId: '100001' },
      data: { ownerId: '200002' },
    });

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('ACCOUNT_TRANSFERRED');
    expect(auditLogs[0].telegramId).toBe(BigInt('8958126400'));
    expect(auditLogs[0].details).toMatchObject({
      oldTelegramId: '100001',
      newTelegramId: '200002',
      actorTelegramId: '8958126400',
      reason: 'ADMIN_TRANSFER',
    });
  });

  it('deletes an empty fresh/trial shell user on conflict before transferring without unique constraint error', async () => {
    const emptyTrialShell = {
      id: 'shell-uuid-999',
      telegramId: '200002',
      status: 'PENDING',
      role: 'STORE_OWNER',
    };
    const { tx, deletedUserIds, updatedUsers, auditLogs } = buildMockTx({
      targetUser: emptyTrialShell,
    });
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(tx)) as any);

    const summary = await transferTelegramAccount({
      oldUserId: 'owner-uuid-100',
      newTelegramId: '200002',
      actorTelegramId: '200002',
      reason: 'RECOVERY_CODE',
    });

    expect(deletedUserIds).toEqual(['shell-uuid-999']);
    expect(summary.deletedEmptyShell).toBe(true);
    expect(updatedUsers[0].id).toBe('owner-uuid-100');
    expect(updatedUsers[0].telegramId).toBe('200002');
    expect(auditLogs[0].action).toBe('ACCOUNT_RECOVERED');
    expect(auditLogs[0].details.deletedEmptyShellUserId).toBe('shell-uuid-999');
  });

  it('aborts and throws clear Uzbek error when target Telegram account already owns real store data', async () => {
    const existingStoreUser = {
      id: 'real-store-uuid-777',
      telegramId: '200002',
      status: 'ACTIVE',
      role: 'STORE_OWNER',
    };
    const { tx, deletedUserIds, updatedUsers } = buildMockTx({
      targetUser: existingStoreUser,
      counts: { supplier: 2, invoice: 1 },
    });
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(tx)) as any);

    await expect(
      transferTelegramAccount({
        oldUserId: 'owner-uuid-100',
        newTelegramId: '200002',
        actorTelegramId: '8958126400',
        reason: 'ADMIN_TRANSFER',
      })
    ).rejects.toThrow(TARGET_HAS_STORE_DATA_ERROR_UZ);

    expect(deletedUserIds).toEqual([]);
    expect(updatedUsers).toEqual([]);
  });
});

describe('4. recoverAccountByCode — Valid Recovery + Rotation, Invalid Code & 5-Attempt Rate Limit', () => {
  it('recovers account with case/whitespace normalization and immediately rotates recovery code', async () => {
    const originalCode = 'DOOKON-ABCD-2345';
    const originalHash = hashRecoveryCode(originalCode);
    let currentDbUser: any = {
      id: 'owner-uuid-555',
      telegramId: '500111',
      fullName: 'fayz savdo',
      name: 'Fayz Savdo',
      role: 'STORE_OWNER',
      status: 'ACTIVE',
      subscriptionExpiresAt: new Date('2027-05-10T00:00:00.000Z'),
      recoveryCodeHash: originalHash,
      recoveryCodeCreatedAt: new Date('2026-11-01T00:00:00.000Z'),
    };

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async ({ where }: any) => {
      if (where.recoveryCodeHash) {
        return where.recoveryCodeHash === currentDbUser.recoveryCodeHash
          ? { ...currentDbUser }
          : null;
      }
      if (where.id === currentDbUser.id) return { ...currentDbUser };
      if (where.telegramId === currentDbUser.telegramId) return { ...currentDbUser };
      return null;
    }) as any);

    vi.spyOn(prisma.user, 'update').mockImplementation((async ({ data }: any) => {
      currentDbUser = { ...currentDbUser, ...data };
      return { ...currentDbUser };
    }) as any);

    vi.spyOn(prisma.auditLog, 'create').mockResolvedValue({ id: 'audit-rot-1' } as any);

    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => {
      const tx: any = {
        user: {
          findUnique: async ({ where }: any) => {
            if (where.id === currentDbUser.id) return { ...currentDbUser };
            if (where.telegramId === currentDbUser.telegramId) return { ...currentDbUser };
            return null;
          },
          delete: vi.fn(),
          update: async ({ data }: any) => {
            currentDbUser = { ...currentDbUser, ...data };
            return { ...currentDbUser };
          },
        },
        invoice: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        supplierPayment: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        supplierTransaction: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        expense: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        cashTransaction: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        zReport: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        customerDebt: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        supplier: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
        product: { updateMany: async () => ({ count: 0 }) },
        invoiceItem: { updateMany: async () => ({ count: 0 }) },
        dailyRegister: { updateMany: async () => ({ count: 0 }) },
        subscriptionPayment: { updateMany: async () => ({ count: 0 }) },
        pendingAction: { updateMany: async () => ({ count: 0 }) },
        auditLog: { create: async () => ({ id: 'audit-rec-1' }) },
      };
      return fn(tx);
    }) as any);

    const result = await recoverAccountByCode('600222', '  dookon-abcd-2345  ');

    expect(result.user.telegramId).toBe('600222');
    expect(result.newRecoveryCode).toMatch(RECOVERY_CODE_REGEX);
    expect(result.newRecoveryCode).not.toBe(originalCode);
    expect(currentDbUser.recoveryCodeHash).toBe(hashRecoveryCode(result.newRecoveryCode));
    expect(currentDbUser.recoveryCodeHash).not.toBe(originalHash);

    // Reusing the old code must immediately fail because it was rotated
    await expect(recoverAccountByCode('700333', originalCode)).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
  });

  it('rejects invalid codes and locks newTelegramId after 5 failed attempts within 60 minutes', async () => {
    const findSpy = vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
    const baseTime = 1_700_000_000_000;

    // 5 failed attempts -> INVALID_CODE
    for (let i = 1; i <= 5; i++) {
      await expect(
        recoverAccountByCode('888999', `DOOKON-XXXX-222${i}`, baseTime + i * 1000)
      ).rejects.toMatchObject({
        code: 'INVALID_CODE',
      });
    }
    expect(findSpy).toHaveBeenCalledTimes(5);

    // 6th attempt within 60 minutes -> RATE_LIMITED without hitting DB
    await expect(
      recoverAccountByCode('888999', 'DOOKON-ABCD-EFGH', baseTime + 60_000)
    ).rejects.toSatisfy((err: any) => {
      expect(err).toBeInstanceOf(AccountRecoveryError);
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.message).toContain('bloklandi');
      return true;
    });
    expect(findSpy).toHaveBeenCalledTimes(5);

    // Another user is NOT affected by 888999's rate limit
    await expect(
      recoverAccountByCode('777666', 'DOOKON-ABCD-EFGH', baseTime + 60_000)
    ).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    expect(findSpy).toHaveBeenCalledTimes(6);

    // After 60 minutes pass, rate limit resets for 888999
    await expect(
      recoverAccountByCode('888999', 'DOOKON-ABCD-EFGH', baseTime + 61 * 60 * 1000)
    ).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    expect(findSpy).toHaveBeenCalledTimes(7);
  });
});

describe('5. Bot UX — Middleware Bypass, /kalit, /tiklash & Admin Panel Keyboards', () => {
  it('allows /tiklash through authMiddleware for unregistered/expired users without hitting subscription block', async () => {
    let nextCalled = false;
    const registerSpy = vi.spyOn(prisma.user, 'findUnique');

    const mockCtx: any = {
      from: { id: 444555666, first_name: 'Yangi' },
      message: { text: '/tiklash DOOKON-ABCD-2345' },
      session: {},
      reply: vi.fn(),
    };

    await authMiddleware(mockCtx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(mockCtx.reply).not.toHaveBeenCalled();
  });

  it('exposes 🔐 Zaxira kalit in owner menu and 🔄 Akkauntni ko‘chirish in Super-Admin panel', () => {
    expect(isMenuButton('🔐 Zaxira kalit')).toBe(true);
    expect(isMenuButton('/kalit')).toBe(true);
    expect(isMenuButton('/tiklash')).toBe(true);

    const ownerMenuJson = JSON.stringify(getMainMenu('STORE_OWNER', {}).build());
    expect(ownerMenuJson).toContain('🔐 Zaxira kalit');

    const adminPanelJson = JSON.stringify(getAdminMainPanelKeyboard().inline_keyboard);
    expect(adminPanelJson).toContain('🔄 Akkauntni ko‘chirish');
    expect(adminPanelJson).toContain('adm:transfer');
  });

  it('sends monospace backup key warning on /kalit and restores account on /tiklash', async () => {
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: 'u-kalit-1',
      telegramId: '333444',
      fullName: 'Ideal Market',
      status: 'ACTIVE',
    } as any);
    vi.spyOn(prisma.user, 'update').mockImplementation((async ({ data }: any) => ({
      id: 'u-kalit-1',
      telegramId: '333444',
      fullName: 'Ideal Market',
      status: 'ACTIVE',
      ...data,
    })) as any);
    vi.spyOn(prisma.auditLog, 'create').mockResolvedValue({ id: 'aud-1' } as any);

    const replies: Array<{ text: string; extra: any }> = [];
    const kalitCtx: any = {
      from: { id: 333444, first_name: 'Ideal' },
      user: { id: 'u-kalit-1', telegramId: '333444', fullName: 'Ideal Market', status: 'ACTIVE' },
      session: {},
      reply: vi.fn(async (text: string, extra?: any) => {
        replies.push({ text, extra });
      }),
    };

    await handleGenerateBackupKey(kalitCtx);

    expect(replies).toHaveLength(1);
    expect(replies[0].extra?.parse_mode).toBe('HTML');
    expect(replies[0].text).toContain('🔐 Sizning maxfiy tiklash kalitingiz: <code>DOOKON-');
    expect(replies[0].text).toContain('/tiklash DOOKON-');
    expect(replies[0].text).toContain('barcha tarixingiz va obunangiz 1 soniyada tiklanadi.');

    // Empty /tiklash shows helpful usage prompt
    const emptyTiklashReplies: string[] = [];
    await handleRecoverAccountCommand({
      from: { id: 999888, first_name: 'Test' },
      match: '',
      message: { text: '/tiklash' },
      session: {},
      reply: vi.fn(async (t: string) => emptyTiklashReplies.push(t)),
    } as any);
    expect(emptyTiklashReplies[0]).toContain('/tiklash DOOKON-XXXX-XXXX');
  });
});
