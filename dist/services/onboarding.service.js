"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OnboardingService = exports.ONBOARDING_FINISH_MESSAGE = exports.ONBOARDING_SLIDES = exports.ONBOARDING_SLIDE_INDICES = exports.ONBOARDING_SETTINGS_KEY = void 0;
exports.formatOnboardingSlideText = formatOnboardingSlideText;
exports.isValidOnboardingSlideIndex = isValidOnboardingSlideIndex;
exports.clampOnboardingSlideIndex = clampOnboardingSlideIndex;
exports.parseOnboardingSlideCallback = parseOnboardingSlideCallback;
exports.createEmptyOnboardingMediaConfig = createEmptyOnboardingMediaConfig;
exports.parseOnboardingMediaJson = parseOnboardingMediaJson;
exports.invalidateOnboardingMediaCache = invalidateOnboardingMediaCache;
exports.getOnboardingMedia = getOnboardingMedia;
exports.setOnboardingIntroVideo = setOnboardingIntroVideo;
exports.setOnboardingSlideMedia = setOnboardingSlideMedia;
exports.clearOnboardingMedia = clearOnboardingMedia;
const prisma_1 = require("../database/prisma");
exports.ONBOARDING_SETTINGS_KEY = 'ONBOARDING_MEDIA';
exports.ONBOARDING_SLIDE_INDICES = [1, 2, 3, 4];
exports.ONBOARDING_SLIDES = {
    1: {
        index: 1,
        title: '📸 1/4 — Cheklarni rasm orqali o‘qish',
        body: 'Qo‘lda yozilgan yoki bosma nakladnoyni rasmga olib tashlang. Bot 3 soniyada barcha tovarlarni bazaga kiritadi va biror tovar narxi oshgan bo‘lsa, darrov ogohlantiradi.',
    },
    2: {
        index: 2,
        title: '🎙 2/4 — Menyusiz tezkor boshqaruv',
        body: 'Tugma qidirib o‘tirmang. Chatga oddiy qilib yozing yoki ovozli xabar tashlang: «ole narxi», «Millora qarz», «Svetga 300 ming rasxod» yoki «Milloraga 250 ming vozvrat».',
    },
    3: {
        index: 3,
        title: "📄 3/4 — Ta'minotchilar bilan 1 tugmada sverka",
        body: 'Har bir hamkor ichida Cheklar, Pullar va Vozvrat alohida turadi. Bitta tugma bilan 0 dan bugungacha bo‘lgan tarixni PDF qilib, to‘g‘ridan-to‘g‘ri hamkoringizga yuboring.',
    },
    4: {
        index: 4,
        title: '📊 4/4 — Professional CEO Dashboard',
        body: 'Oylik va kunlik taqqoslashlar, xarajat anomaliyalari, yuk olish sikllari va ertalab 09:00 dagi to‘lov eslatmalari — hammasi bitta ekranda.',
    },
};
exports.ONBOARDING_FINISH_MESSAGE = '✅ Ajoyib! Hozirning o‘zida bitta nakladnoy rasmini tashlang yoki «ole narxi» deb yozib sinab ko‘ring.';
function formatOnboardingSlideText(index) {
    const slide = exports.ONBOARDING_SLIDES[index];
    return `<b>${slide.title}</b>\n\n${slide.body}`;
}
function isValidOnboardingSlideIndex(val) {
    return val === 1 || val === 2 || val === 3 || val === 4;
}
function clampOnboardingSlideIndex(raw) {
    if (!Number.isFinite(raw))
        return 1;
    const rounded = Math.trunc(raw);
    if (rounded <= 1)
        return 1;
    if (rounded >= 4)
        return 4;
    return rounded;
}
/**
 * Strictly parses onboarding carousel callback data `onb_slide:<1|2|3|4>`.
 * Returns null if malformed or out of bounds (< 1 or > 4).
 */
function parseOnboardingSlideCallback(data) {
    if (!data)
        return null;
    const match = /^onb_slide:(\d+)$/.exec(data.trim());
    if (!match)
        return null;
    const num = Number(match[1]);
    return isValidOnboardingSlideIndex(num) ? num : null;
}
function createEmptyOnboardingMediaConfig() {
    return { slides: {} };
}
function cloneMediaConfig(cfg) {
    const slides = {};
    for (const idx of exports.ONBOARDING_SLIDE_INDICES) {
        const entry = cfg.slides[idx];
        if (entry && entry.fileId) {
            slides[idx] = { fileId: entry.fileId, type: entry.type };
        }
    }
    return {
        ...(cfg.introVideoFileId && cfg.introVideoType
            ? { introVideoFileId: cfg.introVideoFileId, introVideoType: cfg.introVideoType }
            : {}),
        slides,
    };
}
function parseOnboardingMediaJson(raw) {
    if (!raw || !raw.trim())
        return createEmptyOnboardingMediaConfig();
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return createEmptyOnboardingMediaConfig();
        }
        const result = { slides: {} };
        if (typeof parsed.introVideoFileId === 'string' &&
            parsed.introVideoFileId.trim() &&
            (parsed.introVideoType === 'video' || parsed.introVideoType === 'video_note')) {
            result.introVideoFileId = parsed.introVideoFileId.trim();
            result.introVideoType = parsed.introVideoType;
        }
        if (parsed.slides && typeof parsed.slides === 'object') {
            for (const idx of exports.ONBOARDING_SLIDE_INDICES) {
                const rawSlide = parsed.slides[idx] ?? parsed.slides[String(idx)];
                if (rawSlide &&
                    typeof rawSlide === 'object' &&
                    typeof rawSlide.fileId === 'string' &&
                    rawSlide.fileId.trim() &&
                    (rawSlide.type === 'photo' || rawSlide.type === 'animation')) {
                    result.slides[idx] = {
                        fileId: rawSlide.fileId.trim(),
                        type: rawSlide.type,
                    };
                }
            }
        }
        return result;
    }
    catch {
        return createEmptyOnboardingMediaConfig();
    }
}
let cachedOnboardingMedia = null;
function invalidateOnboardingMediaCache() {
    cachedOnboardingMedia = null;
}
async function persistOnboardingMedia(config) {
    const normalized = cloneMediaConfig(config);
    const serialized = JSON.stringify(normalized);
    await prisma_1.prisma.systemSettings.upsert({
        where: { id: exports.ONBOARDING_SETTINGS_KEY },
        create: {
            id: exports.ONBOARDING_SETTINGS_KEY,
            tariffInfoText: serialized,
        },
        update: {
            tariffInfoText: serialized,
        },
    });
    invalidateOnboardingMediaCache();
    cachedOnboardingMedia = cloneMediaConfig(normalized);
    return cloneMediaConfig(normalized);
}
/**
 * Loads onboarding media file_id config from SystemSettings (key: ONBOARDING_MEDIA),
 * cached in memory and invalidated on any update.
 */
async function getOnboardingMedia() {
    if (cachedOnboardingMedia) {
        return cloneMediaConfig(cachedOnboardingMedia);
    }
    const row = await prisma_1.prisma.systemSettings.findUnique({
        where: { id: exports.ONBOARDING_SETTINGS_KEY },
        select: { tariffInfoText: true },
    });
    const parsed = parseOnboardingMediaJson(row?.tariffInfoText);
    cachedOnboardingMedia = cloneMediaConfig(parsed);
    return cloneMediaConfig(parsed);
}
async function setOnboardingIntroVideo(fileId, type) {
    const cleanFileId = String(fileId || '').trim();
    if (!cleanFileId) {
        throw new Error('Intro video file_id cannot be empty');
    }
    const current = await getOnboardingMedia();
    current.introVideoFileId = cleanFileId;
    current.introVideoType = type;
    return persistOnboardingMedia(current);
}
async function setOnboardingSlideMedia(slideIndex, fileId, type) {
    if (!isValidOnboardingSlideIndex(slideIndex)) {
        throw new Error(`Invalid onboarding slide index: ${slideIndex}`);
    }
    const cleanFileId = String(fileId || '').trim();
    if (!cleanFileId) {
        throw new Error('Slide media file_id cannot be empty');
    }
    const current = await getOnboardingMedia();
    current.slides[slideIndex] = { fileId: cleanFileId, type };
    return persistOnboardingMedia(current);
}
async function clearOnboardingMedia() {
    return persistOnboardingMedia(createEmptyOnboardingMediaConfig());
}
exports.OnboardingService = {
    getOnboardingMedia,
    setOnboardingIntroVideo,
    setOnboardingSlideMedia,
    clearOnboardingMedia,
    invalidateOnboardingMediaCache,
};
