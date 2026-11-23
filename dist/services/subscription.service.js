"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionService = exports.AUTO_TRIAL_PLAN_NAME = exports.AUTO_TRIAL_DAYS = void 0;
exports.invalidateUserCache = invalidateUserCache;
exports.getCachedUser = getCachedUser;
exports.setCachedUser = setCachedUser;
exports.parseSubscriptionDuration = parseSubscriptionDuration;
exports.isEligibleForAutoTrial = isEligibleForAutoTrial;
const grammy_1 = require("grammy");
const prisma_1 = require("../database/prisma");
const env_1 = require("../config/env");
const formatters_1 = require("../utils/formatters");
const menu_1 = require("../bot/keyboards/menu");
const cache_1 = require("../utils/cache");
function invalidateUserCache(telegramId) {
    (0, cache_1.invalidateCache)(telegramId);
}
function getCachedUser(telegramId) {
    return cache_1.userStatusCache.get(String(telegramId).trim());
}
function setCachedUser(telegramId, user) {
    cache_1.userStatusCache.set(String(telegramId).trim(), user);
}
function unitToDays(value, unitRaw) {
    const u = unitRaw.toLowerCase().trim();
    if (u.startsWith('yil') || u === 'y')
        return Math.round(value * 365);
    if (u.startsWith('oy') || u === 'm')
        return Math.round(value * 30);
    if (u.startsWith('hafta') || u === 'w')
        return Math.round(value * 7);
    return Math.round(value);
}
function formatUnitLabel(value, unitRaw) {
    const u = unitRaw.toLowerCase().trim();
    if (u.startsWith('yil') || u === 'y')
        return `${value} yil`;
    if (u.startsWith('oy') || u === 'm')
        return `${value} oy`;
    if (u.startsWith('hafta') || u === 'w')
        return `${value} hafta`;
    return `${value} kun`;
}
/**
 * MODUL 2.3: Smart parser for custom subscription durations and bonuses.
 * Examples:
 * - "3 oy + 15 kun bonus" -> baseDays: 90, bonusDays: 15, totalDays: 105
 * - "4 oy + 20 kun bonus" -> baseDays: 120, bonusDays: 20, totalDays: 140
 * - "4 oy 1 oy bonus" -> baseDays: 120, bonusDays: 30, totalDays: 150
 * - "2 oy 10 kun" -> baseDays: 70, bonusDays: 0, totalDays: 70
 * - "45 kun" -> baseDays: 45, bonusDays: 0, totalDays: 45
 */
function parseSubscriptionDuration(rawInput) {
    const text = (rawInput || '').trim();
    if (!text) {
        return {
            baseDays: 30,
            bonusDays: 0,
            totalDays: 30,
            monthsGranted: 1,
            planName: '1 Oylik',
            bonusLabel: '',
        };
    }
    const hasPlus = text.includes('+');
    const hasBonusWord = /bonus|sovg'a|sovga|aksiya/i.test(text);
    if (hasPlus) {
        const [leftPart, ...rightParts] = text.split('+');
        const rightPart = rightParts.join(' ');
        const baseInfo = extractTokensFromPart(leftPart);
        const bonusInfo = extractTokensFromPart(rightPart);
        const baseDays = baseInfo.days || 30;
        const bonusDays = bonusInfo.days || 0;
        const totalDays = baseDays + bonusDays;
        const monthsGranted = baseInfo.months > 0 ? baseInfo.months : Math.max(1, Math.round(baseDays / 30));
        const planName = baseInfo.months > 0 ? `${baseInfo.months} Oylik` : baseInfo.label || `${baseDays} kun`;
        const bonusLabel = bonusInfo.label || (bonusDays > 0 ? `${bonusDays} kun` : '');
        return {
            baseDays,
            bonusDays,
            totalDays,
            monthsGranted,
            planName,
            bonusLabel,
        };
    }
    const tokenRegex = /(\d+(?:[.,]\d+)?)\s*(yil|oy|hafta|kun|k)\b/gi;
    const matches = Array.from(text.matchAll(tokenRegex));
    if (matches.length >= 2 && hasBonusWord) {
        const firstVal = parseFloat(matches[0][1].replace(',', '.')) || 0;
        const firstUnit = matches[0][2];
        const baseDays = unitToDays(firstVal, firstUnit);
        const monthsGranted = firstUnit.toLowerCase().startsWith('oy')
            ? Math.round(firstVal)
            : firstUnit.toLowerCase().startsWith('yil')
                ? Math.round(firstVal * 12)
                : Math.max(1, Math.round(baseDays / 30));
        const planName = firstUnit.toLowerCase().startsWith('oy')
            ? `${Math.round(firstVal)} Oylik`
            : formatUnitLabel(firstVal, firstUnit);
        let bonusDays = 0;
        const bonusLabels = [];
        for (let i = 1; i < matches.length; i++) {
            const val = parseFloat(matches[i][1].replace(',', '.')) || 0;
            const unit = matches[i][2];
            bonusDays += unitToDays(val, unit);
            bonusLabels.push(formatUnitLabel(val, unit));
        }
        return {
            baseDays,
            bonusDays,
            totalDays: baseDays + bonusDays,
            monthsGranted,
            planName,
            bonusLabel: bonusLabels.join(' '),
        };
    }
    if (matches.length >= 1) {
        let baseDays = 0;
        let months = 0;
        const labels = [];
        for (const m of matches) {
            const val = parseFloat(m[1].replace(',', '.')) || 0;
            const unit = m[2];
            baseDays += unitToDays(val, unit);
            if (unit.toLowerCase().startsWith('oy'))
                months += Math.round(val);
            if (unit.toLowerCase().startsWith('yil'))
                months += Math.round(val * 12);
            labels.push(formatUnitLabel(val, unit));
        }
        const monthsGranted = months > 0 ? months : Math.max(1, Math.round(baseDays / 30));
        const planName = matches.length === 1 && months > 0 ? `${months} Oylik` : labels.join(' ');
        return {
            baseDays,
            bonusDays: 0,
            totalDays: baseDays,
            monthsGranted,
            planName,
            bonusLabel: '',
        };
    }
    const numOnly = parseInt(text.replace(/[^\d]/g, ''), 10);
    const days = !isNaN(numOnly) && numOnly > 0 ? numOnly : 30;
    return {
        baseDays: days,
        bonusDays: 0,
        totalDays: days,
        monthsGranted: Math.max(1, Math.round(days / 30)),
        planName: `${days} kun`,
        bonusLabel: '',
    };
}
function extractTokensFromPart(part) {
    const tokenRegex = /(\d+(?:[.,]\d+)?)\s*(yil|oy|hafta|kun|k)\b/gi;
    const matches = Array.from(part.matchAll(tokenRegex));
    if (matches.length === 0) {
        const num = parseInt(part.replace(/[^\d]/g, ''), 10);
        if (!isNaN(num) && num > 0) {
            return { days: num, months: 0, label: `${num} kun` };
        }
        return { days: 0, months: 0, label: '' };
    }
    let days = 0;
    let months = 0;
    const labels = [];
    for (const m of matches) {
        const val = parseFloat(m[1].replace(',', '.')) || 0;
        const unit = m[2];
        days += unitToDays(val, unit);
        if (unit.toLowerCase().startsWith('oy'))
            months += Math.round(val);
        if (unit.toLowerCase().startsWith('yil'))
            months += Math.round(val * 12);
        labels.push(formatUnitLabel(val, unit));
    }
    return { days, months, label: labels.join(' ') };
}
exports.AUTO_TRIAL_DAYS = 7;
exports.AUTO_TRIAL_PLAN_NAME = '7 kunlik sinov (Trial)';
/**
 * Determines whether a user is eligible for the automatic 7-day free trial.
 * Strictly preserves Super-Admin bypass and prevents BLOCKED, PAUSED, EXPIRED,
 * or previously-trialed/approved users from receiving another free trial.
 */
function isEligibleForAutoTrial(user) {
    if (SubscriptionService.isSuperAdmin(user.telegramId) || user.role === 'SUPER_ADMIN') {
        return false;
    }
    if (user.status !== 'PENDING') {
        return false;
    }
    return !user.subscriptionExpiresAt && !user.approvedAt && !user.subscriptionPlan;
}
class SubscriptionService {
    static isSuperAdmin(telegramId) {
        return String(telegramId).trim() === String(env_1.env.OWNER_TELEGRAM_ID).trim();
    }
    static async getSystemSettings() {
        return prisma_1.prisma.systemSettings.upsert({
            where: { id: 'global' },
            create: {
                id: 'global',
                paymentCardNumber: '8600 0000 0000 0000',
                paymentCardHolder: 'ADMIN',
                monthlyPriceUzs: 100000,
                tariffInfoText: "1 Oylik: 100,000 so'm | 3 Oy + 15 kun Bonus | 4 Oy + 1 oy Bonus | 6 Oy + 45 kun Bonus | 1 Yil + 2 oy Bonus",
            },
            update: {},
        });
    }
    static async updateSystemSettings(data) {
        await this.getSystemSettings();
        return prisma_1.prisma.systemSettings.update({
            where: { id: 'global' },
            data: {
                ...(data.paymentCardNumber !== undefined ? { paymentCardNumber: data.paymentCardNumber.trim() } : {}),
                ...(data.paymentCardHolder !== undefined ? { paymentCardHolder: data.paymentCardHolder.trim() } : {}),
                ...(data.monthlyPriceUzs !== undefined ? { monthlyPriceUzs: data.monthlyPriceUzs } : {}),
                ...(data.tariffInfoText !== undefined ? { tariffInfoText: data.tariffInfoText.trim() } : {}),
            },
        });
    }
    static buildWelcomePendingMessage() {
        return (`👋 Assalomu alaykum! Do'konchi AI (SmartBaqqol) botiga xush kelibsiz!\n\n` +
            `🤖 Ushbu bot orqali siz o'z do'koningiz uchun alohida shaxsiy bazada:\n` +
            `• Nakladnoylarni rasm orqali 3 soniyada o'qib, narx oshishini kuzatish\n` +
            `• Ta'minotchilar qarzi, vozvrat va sverka (PDF) hisobini yuritish\n` +
            `• Menyusiz matn va ovozli xabar orqali 1 soniyada ish yuritish\n` +
            `• Kunlik Z-Hisobot va haftalik/oylik tahlillarni olishingiz mumkin.\n\n` +
            `🎁 7 kunlik BEPUL sinov (Trial) muddatini darhol faollashtirish uchun pastdagi tugma orqali telefon raqamingizni yuboring 👇`);
    }
    static buildTrialOnboardingMessage(params) {
        const cleanName = String(params.fullName || "Do'kon egasi").replace(/[*_`\[\]]/g, '').trim() || "Do'kon egasi";
        const expStr = (0, formatters_1.formatDateShort)(params.expiresAt);
        return (`🎉 Tabriklaymiz, *${cleanName}*! Sizga *7 kunlik bepul sinov (Trial)* faollashtirildi (${expStr} gacha).\n\n` +
            `⚡️ *30 soniyada ishni boshlang:*\n\n` +
            `📸 *1. Nakladnoy tashlang:* Yuk kelganda chekni rasmga olib yuboring — bot o'zi o'qib, narxlarni solishtiradi.\n\n` +
            `🔎 *2. Menyusiz so'rang:* Shunchaki \`"ole narxi"\` yoki \`"Millora qarz"\` deb yozing — 1 soniyada javob olasiz.\n\n` +
            `🎙 *3. Ovozli boshqaring:* \`"Svetga 300 ming rasxod"\` yoki \`"Milloraga 250 ming vozvrat"\` deb ovozli xabar tashlang.\n\n` +
            `👇 Shaxsiy bazangiz tayyor! Pastdagi menyudan foydalaning yoki to'g'ridan-to'g'ri yozing:`);
    }
    static buildAdminTrialStartedMessage(user) {
        const displayName = (user.fullName || user.name || "Do'kon egasi").trim();
        const phone = (user.phone || 'Kiritilmagan').trim();
        return `🆕 Yangi foydalanuvchi 7 kunlik sinov (Trial) boshladi: ${displayName} (${phone})`;
    }
    static async activateAutoTrialOnContact(params) {
        const now = params.now || new Date();
        const telegramId = String(params.telegramId).trim();
        const { user } = await this.registerOrGetUser({
            telegramId,
            fullName: params.fullName,
            username: params.username,
            phone: params.phone,
        });
        if (!isEligibleForAutoTrial(user)) {
            return {
                activated: false,
                user,
                expiresAt: user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null,
                onboardingMessage: null,
                adminNotification: null,
            };
        }
        const expiresAt = new Date(now.getTime() + exports.AUTO_TRIAL_DAYS * 24 * 60 * 60 * 1000);
        const updatedUser = await prisma_1.prisma.user.update({
            where: { telegramId },
            data: {
                status: 'ACTIVE',
                subscriptionPlan: exports.AUTO_TRIAL_PLAN_NAME,
                subscriptionExpiresAt: expiresAt,
                approvedAt: now,
                lastReminderSentAt: null,
                phone: params.phone,
            },
        });
        invalidateUserCache(telegramId);
        setCachedUser(telegramId, updatedUser);
        return {
            activated: true,
            user: updatedUser,
            expiresAt,
            onboardingMessage: this.buildTrialOnboardingMessage({
                fullName: updatedUser.fullName || updatedUser.name,
                expiresAt,
            }),
            adminNotification: this.buildAdminTrialStartedMessage(updatedUser),
        };
    }
    static buildAdminNewUserRequestMessage(user) {
        const fullName = user.fullName || user.name || "Noma'lum";
        const phone = user.phone || 'Kiritilmagan';
        const username = user.username ? `@${user.username.replace(/^@/, '')}` : 'Kiritilmagan';
        const dt = (0, formatters_1.formatDate)(user.createdAt || new Date());
        return (`🔔 YANGI FOYDALANUVCHI SO'ROVI!\n` +
            `👤 Ismi: ${fullName}\n` +
            `📱 Telefon: ${phone}\n` +
            `🔗 Username: ${username}\n` +
            `🆔 Telegram ID: ${user.telegramId}\n` +
            `📅 Vaqti: ${dt}\n\n` +
            `Ushbu foydalanuvchiga alohida shaxsiy baza ochib, qaysi tarif va bonus bilan ruxsat berasiz?`);
    }
    static getAdminUserGrantKeyboard(telegramId) {
        return new grammy_1.InlineKeyboard()
            .text('✅ 1 Oylik (30 kun)', `adm_grant:${telegramId}:30:0:1 Oylik`)
            .row()
            .text('🎁 3 Oy + 15 kun Bonus (105 kun)', `adm_grant:${telegramId}:90:15:3 Oylik`)
            .row()
            .text('🎁 4 Oy + 1 oy Bonus (150 kun)', `adm_grant:${telegramId}:120:30:4 Oylik`)
            .row()
            .text('🎁 6 Oy + 45 kun Bonus (225 kun)', `adm_grant:${telegramId}:180:45:6 Oylik`)
            .row()
            .text('🔥 1 Yil + 2 oy Bonus (425 kun)', `adm_grant:${telegramId}:365:60:1 Yillik`)
            .row()
            .text('🎁 3 kun Sinov (Trial)', `adm_grant:${telegramId}:3:0:Sinov`)
            .row()
            .text("✏️ O'zim Oy/Kun va Bonus yozaman", `adm_custom:${telegramId}`)
            .row()
            .text('❌ Rad etish / Bloklash', `adm_block:${telegramId}`);
    }
    static getAdminPaymentApprovalKeyboard(paymentId) {
        return new grammy_1.InlineKeyboard()
            .text('✅ +1 Oy', `adm_pay:${paymentId}:30:0:1 Oylik:1`)
            .row()
            .text('🎁 +3 Oy + 15k Bonus', `adm_pay:${paymentId}:90:15:3 Oylik:3`)
            .row()
            .text('🎁 +4 Oy + 1 oy Bonus', `adm_pay:${paymentId}:120:30:4 Oylik:4`)
            .row()
            .text('✏️ Oy/Bonus kiritish', `adm_pay_custom:${paymentId}`)
            .row()
            .text('❌ Rad etish', `adm_pay_reject:${paymentId}`);
    }
    static async registerOrGetUser(params) {
        const telegramId = String(params.telegramId).trim();
        const isSuper = this.isSuperAdmin(telegramId);
        const fullName = (params.fullName || params.username || (isSuper ? 'Super Admin' : "Do'kon egasi")).trim();
        const username = params.username ? params.username.replace(/^@/, '').trim() : null;
        let existing = await prisma_1.prisma.user.findUnique({ where: { telegramId } });
        if (!existing) {
            const created = await prisma_1.prisma.user.create({
                data: {
                    telegramId,
                    fullName,
                    name: fullName,
                    username,
                    phone: params.phone || null,
                    role: isSuper ? 'SUPER_ADMIN' : 'STORE_OWNER',
                    status: isSuper ? 'ACTIVE' : 'PENDING',
                    subscriptionPlan: isSuper ? 'UNLIMITED' : null,
                    subscriptionExpiresAt: isSuper ? new Date('2099-01-01T00:00:00.000Z') : null,
                    approvedAt: isSuper ? new Date() : null,
                },
            });
            setCachedUser(telegramId, created);
            return { user: created, isNew: true };
        }
        const updates = {};
        if (isSuper && (existing.role !== 'SUPER_ADMIN' || existing.status !== 'ACTIVE')) {
            updates.role = 'SUPER_ADMIN';
            updates.status = 'ACTIVE';
            updates.subscriptionPlan = 'UNLIMITED';
            updates.subscriptionExpiresAt = new Date('2099-01-01T00:00:00.000Z');
        }
        else if (!isSuper && existing.role !== 'STORE_OWNER') {
            updates.role = 'STORE_OWNER';
        }
        if (params.phone && params.phone !== existing.phone) {
            updates.phone = params.phone;
        }
        if (fullName && !existing.fullName) {
            updates.fullName = fullName;
            updates.name = fullName;
        }
        if (username && username !== existing.username) {
            updates.username = username;
        }
        if (Object.keys(updates).length > 0) {
            existing = await prisma_1.prisma.user.update({
                where: { telegramId },
                data: updates,
            });
        }
        setCachedUser(telegramId, existing);
        return { user: existing, isNew: false };
    }
    static buildApprovalSmsMessage(params) {
        const expStr = (0, formatters_1.formatDateShort)(params.expiresAt);
        if (params.bonusDays > 0) {
            const bLabel = params.bonusLabel ||
                (params.bonusDays % 30 === 0 ? `${params.bonusDays / 30} oy` : `${params.bonusDays} kun`);
            return (`🎉 Tabriklaymiz! Admin tomonidan sizga botdan foydalanish uchun ruxsat berildi!\n\n` +
                `📦 Tarif: ${params.planName} + 🎁 ${bLabel} BONUS!\n` +
                `📅 Faol muddat: ${expStr} gacha (Jami ${params.totalDays} kun).\n` +
                `🗄 Shaxsiy ma'lumotlar bazangiz tayyor.\n\n` +
                `🚀 Ish faoliyatingizni boshlashingiz mumkin! Quyidagi menyudan foydalaning:`);
        }
        return (`🎉 Tabriklaymiz! Admin tomonidan sizga botdan foydalanish uchun ruxsat berildi!\n\n` +
            `📅 Faol obuna muddati: ${expStr} gacha.\n` +
            `🗄 Shaxsiy ma'lumotlar bazangiz tayyor.\n\n` +
            `🚀 Ish faoliyatingizni boshlashingiz mumkin! Quyidagi menyudan foydalaning:`);
    }
    /**
     * MODUL 2.2, 2.3, 2.4: Grant or extend subscription for a user and immediately send Bot-SMS.
     */
    static async grantSubscription(params) {
        const telegramId = String(params.telegramId).trim();
        const now = params.now || new Date();
        const baseDays = Math.max(1, Math.round(params.baseDays || 30));
        const bonusDays = Math.max(0, Math.round(params.bonusDays || 0));
        const totalDays = baseDays + bonusDays;
        const planName = params.planName || (baseDays % 30 === 0 ? `${baseDays / 30} Oylik` : `${baseDays} kun`);
        const existing = await prisma_1.prisma.user.findUnique({ where: { telegramId } });
        const shouldExtend = params.extendFromExisting !== false &&
            existing?.subscriptionExpiresAt &&
            new Date(existing.subscriptionExpiresAt) > now;
        const baseDate = shouldExtend ? new Date(existing.subscriptionExpiresAt) : now;
        const expiresAt = new Date(baseDate.getTime() + totalDays * 24 * 60 * 60 * 1000);
        const newBonusDaysGranted = params.accumulateBonus === true ? (existing?.bonusDaysGranted || 0) + bonusDays : bonusDays;
        const updatedUser = await prisma_1.prisma.user.upsert({
            where: { telegramId },
            create: {
                telegramId,
                fullName: "Do'kon egasi",
                name: "Do'kon egasi",
                role: this.isSuperAdmin(telegramId) ? 'SUPER_ADMIN' : 'STORE_OWNER',
                status: 'ACTIVE',
                subscriptionPlan: planName,
                bonusDaysGranted: newBonusDaysGranted,
                subscriptionExpiresAt: expiresAt,
                approvedAt: now,
            },
            update: {
                status: 'ACTIVE',
                subscriptionPlan: planName,
                bonusDaysGranted: newBonusDaysGranted,
                subscriptionExpiresAt: expiresAt,
                approvedAt: existing?.approvedAt || now,
                lastReminderSentAt: null,
            },
        });
        invalidateUserCache(telegramId);
        setCachedUser(telegramId, updatedUser);
        const smsText = this.buildApprovalSmsMessage({
            planName,
            bonusDays,
            bonusLabel: params.bonusLabel,
            totalDays,
            expiresAt,
        });
        if (params.sendSms) {
            await params.sendSms(telegramId, smsText, (0, menu_1.getMainMenu)(updatedUser.role));
        }
        return {
            user: updatedUser,
            smsText,
            baseDays,
            bonusDays,
            totalDays,
            expiresAt,
        };
    }
    static async grantCustomSubscriptionText(params) {
        const parsed = parseSubscriptionDuration(params.customText);
        return this.grantSubscription({
            telegramId: params.telegramId,
            baseDays: parsed.baseDays,
            bonusDays: parsed.bonusDays,
            planName: parsed.planName,
            bonusLabel: parsed.bonusLabel,
            now: params.now,
            extendFromExisting: params.extendFromExisting,
            accumulateBonus: params.accumulateBonus,
            sendSms: params.sendSms,
        });
    }
    static async setUserStatus(telegramId, status) {
        const id = String(telegramId).trim();
        const updated = await prisma_1.prisma.user.update({
            where: { telegramId: id },
            data: { status },
        });
        invalidateUserCache(id);
        setCachedUser(id, updated);
        return updated;
    }
    static async submitPaymentScreenshot(params) {
        const userTelegramId = String(params.userTelegramId).trim();
        const settings = await this.getSystemSettings();
        const amountUzs = params.amountUzs !== undefined ? params.amountUzs : Number(settings.monthlyPriceUzs || 100000);
        return prisma_1.prisma.subscriptionPayment.create({
            data: {
                userTelegramId,
                screenshotFileId: params.screenshotFileId,
                amountUzs,
                monthsGranted: 1,
                bonusDaysGranted: 0,
                status: 'PENDING',
            },
        });
    }
    static async approvePaymentScreenshot(params) {
        const payment = await prisma_1.prisma.subscriptionPayment.findUnique({ where: { id: params.paymentId } });
        if (!payment) {
            throw new Error("To'lov cheki topilmadi.");
        }
        const settings = await this.getSystemSettings();
        const monthsGranted = params.monthsGranted || Math.max(1, Math.round(params.baseDays / 30));
        const bonusDays = Math.max(0, Math.round(params.bonusDays || 0));
        const amountUzs = params.amountUzs !== undefined
            ? params.amountUzs
            : Number(settings.monthlyPriceUzs || 100000) * monthsGranted;
        const updatedPayment = await prisma_1.prisma.subscriptionPayment.update({
            where: { id: payment.id },
            data: {
                status: 'APPROVED',
                monthsGranted,
                bonusDaysGranted: bonusDays,
                amountUzs,
            },
        });
        const grantResult = await this.grantSubscription({
            telegramId: payment.userTelegramId,
            baseDays: params.baseDays,
            bonusDays,
            planName: params.planName || `${monthsGranted} Oylik`,
            now: params.now,
            extendFromExisting: params.extendFromExisting,
            sendSms: params.sendSms,
        });
        return {
            payment: updatedPayment,
            ...grantResult,
        };
    }
    static async rejectPaymentScreenshot(paymentId, sendSms) {
        const payment = await prisma_1.prisma.subscriptionPayment.update({
            where: { id: paymentId },
            data: { status: 'REJECTED' },
        });
        if (sendSms) {
            await sendSms(payment.userTelegramId, "❌ Yuborgan to'lov chekingiz Admin tomonidan tasdiqlanmadi. Iltimos, to'lov ma'lumotlarini tekshirib qaytadan yuboring.").catch(() => { });
        }
        return payment;
    }
    /**
     * MODUL 2.5: Daily check for subscriptions expiring within <= 3 days or already expired.
     */
    static async checkExpiringAndExpiredSubscriptions(sendMessage, now = new Date()) {
        const settings = await this.getSystemSettings();
        const activeUsers = await prisma_1.prisma.user.findMany({
            where: {
                status: 'ACTIVE',
                role: { not: 'SUPER_ADMIN' },
                telegramId: { not: env_1.env.OWNER_TELEGRAM_ID },
                subscriptionExpiresAt: { not: null },
            },
        });
        const receiptKb = new grammy_1.InlineKeyboard().text("📸 To'lov chekini (skrinshot) yuborish", 'sub:send_receipt');
        let expiredCount = 0;
        let remindedCount = 0;
        for (const u of activeUsers) {
            if (!u.subscriptionExpiresAt)
                continue;
            const exp = new Date(u.subscriptionExpiresAt);
            const diffMs = exp.getTime() - now.getTime();
            const daysLeft = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
            if (diffMs <= 0) {
                await this.setUserStatus(u.telegramId, 'EXPIRED');
                expiredCount++;
                await sendMessage(u.telegramId, `⏳ Obuna muddatingiz yakunlandi. Davom ettirish uchun to'lov cheki (skrinshot) rasmini yuboring:`, receiptKb).catch(() => { });
            }
            else if (daysLeft <= 3) {
                const lastRem = u.lastReminderSentAt ? new Date(u.lastReminderSentAt) : null;
                const alreadyRemindedToday = lastRem && now.getTime() - lastRem.getTime() < 20 * 60 * 60 * 1000;
                if (!alreadyRemindedToday) {
                    const msg = `⏳ Hurmatli foydalanuvchi, obuna muddatingiz tugashiga ${daysLeft} kun qoldi.\n` +
                        `💳 Karta: ${settings.paymentCardNumber} (${settings.paymentCardHolder})\n` +
                        `💰 Oylik obuna: ${(0, formatters_1.formatSom)(settings.monthlyPriceUzs)} (3 yoki 4 oylik oldindan to'lovga 🎁 BONUS kunlar beriladi!).\n\n` +
                        `To'lov qilgach, quyidagi tugmani bosib chek (skrinshot) rasmini yuboring:`;
                    await sendMessage(u.telegramId, msg, receiptKb).catch(() => { });
                    await prisma_1.prisma.user.update({
                        where: { id: u.id },
                        data: { lastReminderSentAt: now },
                    });
                    remindedCount++;
                }
            }
        }
        return { expiredCount, remindedCount };
    }
    /**
     * MODUL 2.6: SaaS Revenue and User Statistics for Super-Admin Panel.
     */
    static async getSaasStatistics(now = new Date()) {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const [allUsers, approvedPaymentsAll, approvedPaymentsMonth, pendingPaymentsCount,] = await Promise.all([
            prisma_1.prisma.user.findMany({
                where: { telegramId: { not: env_1.env.OWNER_TELEGRAM_ID } },
                orderBy: { createdAt: 'desc' },
            }),
            prisma_1.prisma.subscriptionPayment.aggregate({
                where: { status: 'APPROVED' },
                _sum: { amountUzs: true },
                _count: { id: true },
            }),
            prisma_1.prisma.subscriptionPayment.aggregate({
                where: { status: 'APPROVED', createdAt: { gte: startOfMonth } },
                _sum: { amountUzs: true },
                _count: { id: true },
            }),
            prisma_1.prisma.subscriptionPayment.count({ where: { status: 'PENDING' } }),
        ]);
        const totalUsers = allUsers.length;
        const activeUsers = allUsers.filter((u) => u.status === 'ACTIVE').length;
        const pendingUsers = allUsers.filter((u) => u.status === 'PENDING').length;
        const expiredUsers = allUsers.filter((u) => u.status === 'EXPIRED').length;
        const pausedUsers = allUsers.filter((u) => u.status === 'PAUSED').length;
        const blockedUsers = allUsers.filter((u) => u.status === 'BLOCKED').length;
        const expiringSoonUsers = allUsers.filter((u) => {
            if (u.status !== 'ACTIVE' || !u.subscriptionExpiresAt)
                return false;
            const exp = new Date(u.subscriptionExpiresAt);
            return exp > now && exp <= threeDaysFromNow;
        });
        const totalRevenueUzs = Number(approvedPaymentsAll._sum.amountUzs || 0);
        const monthlyRevenueUzs = Number(approvedPaymentsMonth._sum.amountUzs || 0);
        const approvedPaymentsCount = approvedPaymentsAll._count.id || 0;
        const formattedText = [
            `📊 **SAAS DAROMAD VA OBUNACHILAR STATISTIKASI**`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `👥 **Jami ro'yxatdan o'tgan mijozlar:** ${totalUsers} ta`,
            `🟢 **Faol obunachilar (ACTIVE):** ${activeUsers} ta`,
            `⏳ **Ruxsat kutayotganlar (PENDING):** ${pendingUsers} ta`,
            `⌛️ **Muddati tugaganlar (EXPIRED):** ${expiredUsers} ta`,
            `⏸ **Vaqtincha to'xtatilganlar (PAUSED):** ${pausedUsers} ta`,
            `⛔️ **Bloklanganlar (BLOCKED):** ${blockedUsers} ta`,
            `⚠️ **Yaqin 3 kunda muddati tugaydiganlar:** ${expiringSoonUsers.length} ta`,
            `🧾 **Tasdiq kutayotgan to'lov cheklari:** ${pendingPaymentsCount} ta`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `💰 **Shu oydagi SaaS daromad:** ${(0, formatters_1.formatSom)(monthlyRevenueUzs)} (${approvedPaymentsMonth._count.id || 0} ta to'lov)`,
            `💎 **Jami umumiy SaaS daromad:** ${(0, formatters_1.formatSom)(totalRevenueUzs)} (${approvedPaymentsCount} ta to'lov)`,
        ].join('\n');
        return {
            totalUsers,
            activeUsers,
            pendingUsers,
            expiredUsers,
            pausedUsers,
            blockedUsers,
            expiringSoonCount: expiringSoonUsers.length,
            expiringSoonUsers,
            pendingPaymentsCount,
            monthlyRevenueUzs,
            totalRevenueUzs,
            approvedPaymentsCount,
            formattedText,
        };
    }
}
exports.SubscriptionService = SubscriptionService;
