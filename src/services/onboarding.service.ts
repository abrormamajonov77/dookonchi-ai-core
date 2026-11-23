import { prisma } from '../database/prisma';

export type OnboardingIntroVideoType = 'video' | 'video_note';
export type OnboardingSlideMediaType = 'photo' | 'animation';
export type OnboardingSlideIndex = 1 | 2 | 3 | 4;
export type OnboardingUploadTarget = 'intro' | 'slide_1' | 'slide_2' | 'slide_3' | 'slide_4';

export interface OnboardingSlideMedia {
  fileId: string;
  type: OnboardingSlideMediaType;
}

export interface OnboardingMediaConfig {
  introVideoFileId?: string;
  introVideoType?: OnboardingIntroVideoType;
  slides: {
    [index: number]: OnboardingSlideMedia;
  };
}

export interface OnboardingSlideContent {
  index: OnboardingSlideIndex;
  title: string;
  body: string;
}

export const ONBOARDING_SETTINGS_KEY = 'ONBOARDING_MEDIA';

export const ONBOARDING_SLIDE_INDICES: OnboardingSlideIndex[] = [1, 2, 3, 4];

export const ONBOARDING_SLIDES: Record<OnboardingSlideIndex, OnboardingSlideContent> = {
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

export const ONBOARDING_FINISH_MESSAGE =
  '✅ Ajoyib! Hozirning o‘zida bitta nakladnoy rasmini tashlang yoki «ole narxi» deb yozib sinab ko‘ring.';

export function formatOnboardingSlideText(index: OnboardingSlideIndex): string {
  const slide = ONBOARDING_SLIDES[index];
  return `<b>${slide.title}</b>\n\n${slide.body}`;
}

export function isValidOnboardingSlideIndex(val: number): val is OnboardingSlideIndex {
  return val === 1 || val === 2 || val === 3 || val === 4;
}

export function clampOnboardingSlideIndex(raw: number): OnboardingSlideIndex {
  if (!Number.isFinite(raw)) return 1;
  const rounded = Math.trunc(raw);
  if (rounded <= 1) return 1;
  if (rounded >= 4) return 4;
  return rounded as OnboardingSlideIndex;
}

/**
 * Strictly parses onboarding carousel callback data `onb_slide:<1|2|3|4>`.
 * Returns null if malformed or out of bounds (< 1 or > 4).
 */
export function parseOnboardingSlideCallback(data: string | undefined | null): OnboardingSlideIndex | null {
  if (!data) return null;
  const match = /^onb_slide:(\d+)$/.exec(data.trim());
  if (!match) return null;
  const num = Number(match[1]);
  return isValidOnboardingSlideIndex(num) ? num : null;
}

export function createEmptyOnboardingMediaConfig(): OnboardingMediaConfig {
  return { slides: {} };
}

function cloneMediaConfig(cfg: OnboardingMediaConfig): OnboardingMediaConfig {
  const slides: OnboardingMediaConfig['slides'] = {};
  for (const idx of ONBOARDING_SLIDE_INDICES) {
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

export function parseOnboardingMediaJson(raw?: string | null): OnboardingMediaConfig {
  if (!raw || !raw.trim()) return createEmptyOnboardingMediaConfig();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyOnboardingMediaConfig();
    }

    const result: OnboardingMediaConfig = { slides: {} };
    if (
      typeof parsed.introVideoFileId === 'string' &&
      parsed.introVideoFileId.trim() &&
      (parsed.introVideoType === 'video' || parsed.introVideoType === 'video_note')
    ) {
      result.introVideoFileId = parsed.introVideoFileId.trim();
      result.introVideoType = parsed.introVideoType;
    }

    if (parsed.slides && typeof parsed.slides === 'object') {
      for (const idx of ONBOARDING_SLIDE_INDICES) {
        const rawSlide = parsed.slides[idx] ?? parsed.slides[String(idx)];
        if (
          rawSlide &&
          typeof rawSlide === 'object' &&
          typeof rawSlide.fileId === 'string' &&
          rawSlide.fileId.trim() &&
          (rawSlide.type === 'photo' || rawSlide.type === 'animation')
        ) {
          result.slides[idx] = {
            fileId: rawSlide.fileId.trim(),
            type: rawSlide.type,
          };
        }
      }
    }

    return result;
  } catch {
    return createEmptyOnboardingMediaConfig();
  }
}

let cachedOnboardingMedia: OnboardingMediaConfig | null = null;

export function invalidateOnboardingMediaCache(): void {
  cachedOnboardingMedia = null;
}

async function persistOnboardingMedia(config: OnboardingMediaConfig): Promise<OnboardingMediaConfig> {
  const normalized = cloneMediaConfig(config);
  const serialized = JSON.stringify(normalized);

  await prisma.systemSettings.upsert({
    where: { id: ONBOARDING_SETTINGS_KEY },
    create: {
      id: ONBOARDING_SETTINGS_KEY,
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
export async function getOnboardingMedia(): Promise<OnboardingMediaConfig> {
  if (cachedOnboardingMedia) {
    return cloneMediaConfig(cachedOnboardingMedia);
  }

  const row = await prisma.systemSettings.findUnique({
    where: { id: ONBOARDING_SETTINGS_KEY },
    select: { tariffInfoText: true },
  });

  const parsed = parseOnboardingMediaJson(row?.tariffInfoText);
  cachedOnboardingMedia = cloneMediaConfig(parsed);
  return cloneMediaConfig(parsed);
}

export async function setOnboardingIntroVideo(
  fileId: string,
  type: OnboardingIntroVideoType
): Promise<OnboardingMediaConfig> {
  const cleanFileId = String(fileId || '').trim();
  if (!cleanFileId) {
    throw new Error('Intro video file_id cannot be empty');
  }
  const current = await getOnboardingMedia();
  current.introVideoFileId = cleanFileId;
  current.introVideoType = type;
  return persistOnboardingMedia(current);
}

export async function setOnboardingSlideMedia(
  slideIndex: OnboardingSlideIndex,
  fileId: string,
  type: OnboardingSlideMediaType
): Promise<OnboardingMediaConfig> {
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

export async function clearOnboardingMedia(): Promise<OnboardingMediaConfig> {
  return persistOnboardingMedia(createEmptyOnboardingMediaConfig());
}

export const OnboardingService = {
  getOnboardingMedia,
  setOnboardingIntroVideo,
  setOnboardingSlideMedia,
  clearOnboardingMedia,
  invalidateOnboardingMediaCache,
};
