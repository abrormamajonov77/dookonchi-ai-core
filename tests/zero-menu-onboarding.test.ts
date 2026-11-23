import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseTextCommandLocally } from '../src/utils/local-parser';
import { VoiceIntentSchema } from '../src/services/ai.service';
import {
  AUTO_TRIAL_DAYS,
  AUTO_TRIAL_PLAN_NAME,
  SubscriptionService,
  isEligibleForAutoTrial,
  invalidateUserCache,
} from '../src/services/subscription.service';
import { prisma } from '../src/database/prisma';
import { env } from '../src/config/env';

describe('Zero-Menu Local Parser (0ms offline commands)', () => {
  it('parses product price lookups in Latin and Cyrillic Uzbek', () => {
    expect(parseTextCommandLocally('ole narxi')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'ole',
    });
    expect(parseTextCommandLocally('makaron qancha')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'makaron',
    });
    expect(parseTextCommandLocally('un oxirgi narxi')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'un',
    });
    expect(parseTextCommandLocally('shakar bahosi')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'shakar',
    });
    expect(parseTextCommandLocally('kola necha pul')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'kola',
    });
    expect(parseTextCommandLocally('Kola 1.5l oxirgi narxi')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'Kola 1.5l',
    });
    expect(parseTextCommandLocally('Макарон нархи')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'Makaron',
    });
    expect(parseTextCommandLocally('Оле қанча?')).toMatchObject({
      intent: 'SEARCH_PRODUCT',
      name: 'Ole',
    });
  });

  it('parses supplier/customer debt lookups and general "qarzlarim" -> ALL', () => {
    expect(parseTextCommandLocally('Millora qarz')).toMatchObject({
      intent: 'GET_DEBT_INFO',
      name: 'Millora',
    });
    expect(parseTextCommandLocally('Millora qarzi')).toMatchObject({
      intent: 'GET_DEBT_INFO',
      name: 'Millora',
    });
    expect(parseTextCommandLocally('Millora qarzi qancha')).toMatchObject({
      intent: 'GET_DEBT_INFO',
      name: 'Millora',
    });
    expect(parseTextCommandLocally('Millora hisob')).toMatchObject({
      intent: 'GET_DEBT_INFO',
      name: 'Millora',
    });
    expect(parseTextCommandLocally('Milterdan qancha qarzim bor?')).toMatchObject({
      intent: 'GET_DEBT_INFO',
      name: 'Milter',
    });
    expect(parseTextCommandLocally('qarzlarim')).toMatchObject({
      intent: 'GET_DEBT_INFO',
      name: 'ALL',
    });
    expect(parseTextCommandLocally('Қарзларим')).toMatchObject({
      intent: 'GET_DEBT_INFO',
      name: 'ALL',
    });
  });

  it('parses supplier return (vozvrat) commands with Uzbek shorthands, USD, and optional notes', () => {
    expect(parseTextCommandLocally("Milloraga 250 ming yog' vozvrat")).toMatchObject({
      intent: 'ADD_SUPPLIER_RETURN',
      supplierName: 'Millora',
      name: 'Millora',
      amount: 250000,
      currency: 'UZS',
      txType: 'RETURN',
      note: "yog'",
    });

    expect(parseTextCommandLocally('Milloraga 250 ming vozvrat')).toMatchObject({
      intent: 'ADD_SUPPLIER_RETURN',
      supplierName: 'Millora',
      amount: 250000,
      currency: 'UZS',
      txType: 'RETURN',
    });

    expect(parseTextCommandLocally('Millora 50$ vozvrat')).toMatchObject({
      intent: 'ADD_SUPPLIER_RETURN',
      supplierName: 'Millora',
      amount: 50,
      currency: 'USD',
      txType: 'RETURN',
    });

    expect(parseTextCommandLocally('Azamatga 1.5 mln brak qaytardim')).toMatchObject({
      intent: 'ADD_SUPPLIER_RETURN',
      supplierName: 'Azamat',
      amount: 1500000,
      currency: 'UZS',
      note: 'brak',
    });

    expect(parseTextCommandLocally('Миллорага 50 dollar қайтди')).toMatchObject({
      intent: 'ADD_SUPPLIER_RETURN',
      supplierName: 'Millora',
      amount: 50,
      currency: 'USD',
    });
  });

  it('parses colloquial Uzbek "rasxod" expenses offline', () => {
    expect(parseTextCommandLocally('Svetga 300 ming rasxod')).toMatchObject({
      intent: 'ADD_EXPENSE',
      amount: 300000,
      currency: 'UZS',
      category: 'Svet',
    });
  });
});

describe('Gemini VoiceIntentSchema ADD_SUPPLIER_RETURN support', () => {
  it('validates ADD_SUPPLIER_RETURN intent payloads with supplierName and note', () => {
    const parsed = VoiceIntentSchema.parse({
      intent: 'ADD_SUPPLIER_RETURN',
      supplierName: 'Millora',
      name: 'Millora',
      amount: 250000,
      currency: 'UZS',
      note: "5 ta yog' singan",
    });
    expect(parsed.intent).toBe('ADD_SUPPLIER_RETURN');
    expect(parsed.supplierName).toBe('Millora');
    expect(parsed.amount).toBe(250000);
    expect(parsed.currency).toBe('UZS');
    expect(parsed.note).toBe("5 ta yog' singan");
  });
});

describe('SaaS 7-Day Auto-Trial & 30-Second Onboarding', () => {
  it('evaluates trial eligibility strictly (only brand-new PENDING users)', () => {
    expect(
      isEligibleForAutoTrial({
        telegramId: '555000111',
        role: 'STORE_OWNER',
        status: 'PENDING',
        subscriptionPlan: null,
        subscriptionExpiresAt: null,
        approvedAt: null,
      })
    ).toBe(true);

    // Super-Admin bypass remains untouched
    expect(
      isEligibleForAutoTrial({
        telegramId: env.OWNER_TELEGRAM_ID,
        role: 'SUPER_ADMIN',
        status: 'PENDING',
        subscriptionPlan: null,
        subscriptionExpiresAt: null,
        approvedAt: null,
      })
    ).toBe(false);

    // BLOCKED, PAUSED, EXPIRED, ACTIVE, or previously trialed users must NOT get a free trial
    for (const status of ['BLOCKED', 'PAUSED', 'EXPIRED', 'ACTIVE']) {
      expect(
        isEligibleForAutoTrial({
          telegramId: '555000222',
          role: 'STORE_OWNER',
          status,
          subscriptionPlan: null,
          subscriptionExpiresAt: null,
          approvedAt: null,
        })
      ).toBe(false);
    }

    expect(
      isEligibleForAutoTrial({
        telegramId: '555000333',
        role: 'STORE_OWNER',
        status: 'PENDING',
        subscriptionPlan: AUTO_TRIAL_PLAN_NAME,
        subscriptionExpiresAt: new Date('2026-11-01T00:00:00Z'),
        approvedAt: new Date('2026-10-25T00:00:00Z'),
      })
    ).toBe(false);
  });

  it('builds the 30-second onboarding message and concise admin trial notification', () => {
    const onboarding = SubscriptionService.buildTrialOnboardingMessage({
      fullName: 'Dilshod',
      expiresAt: new Date('2026-11-30T12:00:00Z'),
    });
    expect(onboarding).toContain('7 kunlik bepul sinov (Trial)');
    expect(onboarding).toContain('1. Nakladnoy tashlang:');
    expect(onboarding).toContain('2. Menyusiz so\'rang:');
    expect(onboarding).toContain('"ole narxi"');
    expect(onboarding).toContain('"Millora qarz"');
    expect(onboarding).toContain('3. Ovozli boshqaring:');
    expect(onboarding).toContain('"Svetga 300 ming rasxod"');
    expect(onboarding).toContain('"Milloraga 250 ming vozvrat"');

    const adminMsg = SubscriptionService.buildAdminTrialStartedMessage({
      fullName: 'Dilshod',
      phone: '+998901234567',
    });
    expect(adminMsg).toBe('🆕 Yangi foydalanuvchi 7 kunlik sinov (Trial) boshladi: Dilshod (+998901234567)');
  });

  const TRIAL_USER_ID = '999777666111';
  const BLOCKED_USER_ID = '999777666222';

  async function cleanupTrialUsers() {
    await prisma.user.deleteMany({
      where: { telegramId: { in: [TRIAL_USER_ID, BLOCKED_USER_ID] } },
    });
    invalidateUserCache(TRIAL_USER_ID);
    invalidateUserCache(BLOCKED_USER_ID);
  }

  beforeAll(async () => {
    await cleanupTrialUsers();
  }, 60000);

  afterAll(async () => {
    await cleanupTrialUsers();
  }, 60000);

  it(
    'activates 7-day auto-trial once on contact share and prevents repeat trial after expiry or block',
    async () => {
      const now = new Date('2026-11-23T12:00:00.000Z');
      const expectedExp = new Date(now.getTime() + AUTO_TRIAL_DAYS * 24 * 60 * 60 * 1000);

      // 1. User runs /start -> PENDING
      const reg = await SubscriptionService.registerOrGetUser({
        telegramId: TRIAL_USER_ID,
        fullName: 'Sardor Test',
        username: 'sardortest',
      });
      expect(reg.user.status).toBe('PENDING');

      // 2. User shares contact -> automatically ACTIVE for 7 days
      const trialRes = await SubscriptionService.activateAutoTrialOnContact({
        telegramId: TRIAL_USER_ID,
        fullName: 'Sardor Test',
        username: 'sardortest',
        phone: '+998901112233',
        now,
      });

      expect(trialRes.activated).toBe(true);
      expect(trialRes.user.status).toBe('ACTIVE');
      expect(trialRes.user.subscriptionPlan).toBe(AUTO_TRIAL_PLAN_NAME);
      expect(trialRes.expiresAt?.getTime()).toBe(expectedExp.getTime());
      expect(trialRes.adminNotification).toBe(
        '🆕 Yangi foydalanuvchi 7 kunlik sinov (Trial) boshladi: Sardor Test (+998901112233)'
      );
      expect(trialRes.onboardingMessage).toContain('ole narxi');

      // 3. After expiry, sharing contact again must NOT grant another free trial
      await SubscriptionService.setUserStatus(TRIAL_USER_ID, 'EXPIRED');
      const secondAttempt = await SubscriptionService.activateAutoTrialOnContact({
        telegramId: TRIAL_USER_ID,
        fullName: 'Sardor Test',
        phone: '+998901112233',
        now: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
      });
      expect(secondAttempt.activated).toBe(false);
      expect(secondAttempt.user.status).toBe('EXPIRED');

      // 4. BLOCKED user sharing contact must remain BLOCKED
      await SubscriptionService.registerOrGetUser({
        telegramId: BLOCKED_USER_ID,
        fullName: 'Blocked User',
      });
      await SubscriptionService.setUserStatus(BLOCKED_USER_ID, 'BLOCKED');

      const blockedAttempt = await SubscriptionService.activateAutoTrialOnContact({
        telegramId: BLOCKED_USER_ID,
        fullName: 'Blocked User',
        phone: '+998909998877',
        now,
      });
      expect(blockedAttempt.activated).toBe(false);
      expect(blockedAttempt.user.status).toBe('BLOCKED');
    },
    60000
  );
});
