import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/database/prisma';
import {
  clampOnboardingSlideIndex,
  clearOnboardingMedia,
  formatOnboardingSlideText,
  getOnboardingMedia,
  invalidateOnboardingMediaCache,
  ONBOARDING_FINISH_MESSAGE,
  ONBOARDING_SETTINGS_KEY,
  parseOnboardingMediaJson,
  parseOnboardingSlideCallback,
  setOnboardingIntroVideo,
  setOnboardingSlideMedia,
} from '../src/services/onboarding.service';
import { getOnboardingCarouselKeyboard } from '../src/bot/keyboards/inline';
import { getMainMenu, isMenuButton } from '../src/bot/keyboards/menu';
import {
  handleOnboardingSlideTransition,
  sendOnboardingCarousel,
} from '../src/bot/handlers/start';
import {
  getAdminMainPanelKeyboard,
  getOnboardingMediaPanelKeyboard,
} from '../src/bot/handlers/admin';

beforeEach(() => {
  invalidateOnboardingMediaCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateOnboardingMediaCache();
});

describe('OnboardingService — SystemSettings Storage & In-Memory Cache', () => {
  it('safely parses valid, empty, malformed, and out-of-range onboarding JSON', () => {
    expect(parseOnboardingMediaJson(null)).toEqual({ slides: {} });
    expect(parseOnboardingMediaJson('not-valid-json')).toEqual({ slides: {} });

    const parsed = parseOnboardingMediaJson(
      JSON.stringify({
        introVideoFileId: 'vid_note_123',
        introVideoType: 'video_note',
        slides: {
          1: { fileId: 'photo_1', type: 'photo' },
          2: { fileId: 'gif_2', type: 'animation' },
          5: { fileId: 'ignored_out_of_range', type: 'photo' },
          3: { fileId: 'bad_type', type: 'video' },
        },
      })
    );

    expect(parsed).toEqual({
      introVideoFileId: 'vid_note_123',
      introVideoType: 'video_note',
      slides: {
        1: { fileId: 'photo_1', type: 'photo' },
        2: { fileId: 'gif_2', type: 'animation' },
      },
    });
  });

  it('caches getOnboardingMedia in memory and invalidates on set/clear updates', async () => {
    let storedJson: string | null = null;

    const findSpy = vi
      .spyOn(prisma.systemSettings, 'findUnique')
      .mockImplementation(async () => ({ tariffInfoText: storedJson } as any));

    const upsertSpy = vi
      .spyOn(prisma.systemSettings, 'upsert')
      .mockImplementation(async (args: any) => {
        storedJson = args.update?.tariffInfoText ?? args.create?.tariffInfoText ?? null;
        return { id: ONBOARDING_SETTINGS_KEY, tariffInfoText: storedJson } as any;
      });

    // First read queries DB once
    const first = await getOnboardingMedia();
    expect(first).toEqual({ slides: {} });
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect((findSpy.mock.calls[0][0] as any).where).toEqual({ id: ONBOARDING_SETTINGS_KEY });

    // Second read hits in-memory cache (still 1 DB query)
    const second = await getOnboardingMedia();
    expect(second).toEqual({ slides: {} });
    expect(findSpy).toHaveBeenCalledTimes(1);

    // Mutating returned clone must NOT corrupt internal cache
    second.slides[1] = { fileId: 'mutated', type: 'photo' };
    expect((await getOnboardingMedia()).slides[1]).toBeUndefined();

    // Update intro video & slides
    await setOnboardingIntroVideo('intro_vid_abc', 'video_note');
    await setOnboardingSlideMedia(1, 'slide_1_photo', 'photo');
    await setOnboardingSlideMedia(2, 'slide_2_gif', 'animation');
    expect(upsertSpy).toHaveBeenCalledTimes(3);

    const updated = await getOnboardingMedia();
    expect(updated).toEqual({
      introVideoFileId: 'intro_vid_abc',
      introVideoType: 'video_note',
      slides: {
        1: { fileId: 'slide_1_photo', type: 'photo' },
        2: { fileId: 'slide_2_gif', type: 'animation' },
      },
    });

    // Clear resets both DB and cache
    const cleared = await clearOnboardingMedia();
    expect(cleared).toEqual({ slides: {} });
    expect(await getOnboardingMedia()).toEqual({ slides: {} });
  });
});

describe('Onboarding Carousel — Callback Boundaries, Slide Content & Keyboards', () => {
  it('validates strict slide callback boundaries (1..4) and rejects out-of-range callbacks', () => {
    expect(parseOnboardingSlideCallback('onb_slide:1')).toBe(1);
    expect(parseOnboardingSlideCallback('onb_slide:2')).toBe(2);
    expect(parseOnboardingSlideCallback('onb_slide:3')).toBe(3);
    expect(parseOnboardingSlideCallback('onb_slide:4')).toBe(4);

    expect(parseOnboardingSlideCallback('onb_slide:0')).toBeNull();
    expect(parseOnboardingSlideCallback('onb_slide:5')).toBeNull();
    expect(parseOnboardingSlideCallback('onb_slide:-1')).toBeNull();
    expect(parseOnboardingSlideCallback('onb_slide:abc')).toBeNull();
    expect(parseOnboardingSlideCallback('other:1')).toBeNull();

    expect(clampOnboardingSlideIndex(0)).toBe(1);
    expect(clampOnboardingSlideIndex(99)).toBe(4);
    expect(clampOnboardingSlideIndex(NaN)).toBe(1);
  });

  it('generates exact navigation buttons for all 4 slides', () => {
    const kb1 = getOnboardingCarouselKeyboard(1).inline_keyboard;
    expect(kb1).toEqual([[{ text: 'Keyingisi (2/4) ➡️', callback_data: 'onb_slide:2' }]]);

    const kb2 = getOnboardingCarouselKeyboard(2).inline_keyboard;
    expect(kb2).toEqual([
      [
        { text: '⬅️ Oldingi', callback_data: 'onb_slide:1' },
        { text: 'Keyingisi (3/4) ➡️', callback_data: 'onb_slide:3' },
      ],
    ]);

    const kb3 = getOnboardingCarouselKeyboard(3).inline_keyboard;
    expect(kb3).toEqual([
      [
        { text: '⬅️ Oldingi', callback_data: 'onb_slide:2' },
        { text: 'Keyingisi (4/4) ➡️', callback_data: 'onb_slide:4' },
      ],
    ]);

    const kb4 = getOnboardingCarouselKeyboard(4).inline_keyboard;
    expect(kb4).toEqual([
      [
        { text: '⬅️ Oldingi', callback_data: 'onb_slide:3' },
        { text: '🚀 Ishni boshlash', callback_data: 'onb_finish' },
      ],
    ]);
  });

  it('formats all 4 Uzbek slides and finish confirmation message accurately', () => {
    expect(formatOnboardingSlideText(1)).toContain('📸 1/4 — Cheklarni rasm orqali o‘qish');
    expect(formatOnboardingSlideText(2)).toContain('🎙 2/4 — Menyusiz tezkor boshqaruv');
    expect(formatOnboardingSlideText(3)).toContain("📄 3/4 — Ta'minotchilar bilan 1 tugmada sverka");
    expect(formatOnboardingSlideText(4)).toContain('📊 4/4 — Professional CEO Dashboard');
    expect(ONBOARDING_FINISH_MESSAGE).toContain('«ole narxi»');
  });
});

describe('Onboarding Carousel — Smooth In-Place Transitions & Intro Video', () => {
  it('sends intro video_note first followed by Slide 1 photo when configured', async () => {
    vi.spyOn(prisma.systemSettings, 'findUnique').mockResolvedValue({
      tariffInfoText: JSON.stringify({
        introVideoFileId: 'krujochek_1',
        introVideoType: 'video_note',
        slides: { 1: { fileId: 'slide_photo_1', type: 'photo' } },
      }),
    } as any);

    const callOrder: string[] = [];
    const mockCtx: any = {
      replyWithVideoNote: vi.fn(async (id: string) => {
        callOrder.push(`video_note:${id}`);
      }),
      replyWithPhoto: vi.fn(async (id: string) => {
        callOrder.push(`photo:${id}`);
      }),
      reply: vi.fn(),
    };

    await sendOnboardingCarousel(mockCtx, { includeIntroVideo: true });

    expect(callOrder).toEqual(['video_note:krujochek_1', 'photo:slide_photo_1']);
  });

  it('uses editMessageMedia when switching between two media slides (0 spam)', async () => {
    vi.spyOn(prisma.systemSettings, 'findUnique').mockResolvedValue({
      tariffInfoText: JSON.stringify({
        slides: {
          1: { fileId: 'photo_1', type: 'photo' },
          2: { fileId: 'gif_2', type: 'animation' },
        },
      }),
    } as any);

    const mockCtx: any = {
      chat: { id: 1001 },
      callbackQuery: {
        message: { message_id: 55, photo: [{ file_id: 'photo_1' }] },
      },
      editMessageMedia: vi.fn(async () => {}),
      editMessageText: vi.fn(),
      replyWithAnimation: vi.fn(),
      api: { deleteMessage: vi.fn() },
    };

    await handleOnboardingSlideTransition(mockCtx, 2);

    expect(mockCtx.editMessageMedia).toHaveBeenCalledTimes(1);
    expect(mockCtx.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('uses editMessageText when switching between two text-only slides', async () => {
    vi.spyOn(prisma.systemSettings, 'findUnique').mockResolvedValue({
      tariffInfoText: JSON.stringify({ slides: {} }),
    } as any);

    const mockCtx: any = {
      chat: { id: 1001 },
      callbackQuery: {
        message: { message_id: 56, text: 'old slide' },
      },
      editMessageText: vi.fn(async () => {}),
      editMessageMedia: vi.fn(),
      api: { deleteMessage: vi.fn() },
    };

    await handleOnboardingSlideTransition(mockCtx, 3);

    expect(mockCtx.editMessageText).toHaveBeenCalledTimes(1);
    expect(mockCtx.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('cleanly replaces message when switching between text-only and media slide without throwing', async () => {
    vi.spyOn(prisma.systemSettings, 'findUnique').mockResolvedValue({
      tariffInfoText: JSON.stringify({
        slides: { 2: { fileId: 'photo_2', type: 'photo' } },
      }),
    } as any);

    const mockCtx: any = {
      chat: { id: 1001 },
      callbackQuery: {
        message: { message_id: 57, text: 'slide 1 text-only' },
      },
      replyWithPhoto: vi.fn(async () => {}),
      api: { deleteMessage: vi.fn(async () => {}) },
    };

    await handleOnboardingSlideTransition(mockCtx, 2);

    expect(mockCtx.replyWithPhoto).toHaveBeenCalledTimes(1);
    expect(mockCtx.api.deleteMessage).toHaveBeenCalledWith(1001, 57);
  });
});

describe('Menu & Super-Admin Onboarding Media Keyboards', () => {
  it('exposes ❓ Yo‘riqnoma in owner menu and recognizes /help as a system menu trigger', () => {
    expect(isMenuButton('❓ Yo‘riqnoma')).toBe(true);
    expect(isMenuButton("❓ Yo'riqnoma")).toBe(true);
    expect(isMenuButton('/help')).toBe(true);

    const menuJson = JSON.stringify(getMainMenu('STORE_OWNER', {}).build());
    expect(menuJson).toContain('❓ Yo‘riqnoma');
  });

  it('exposes 🎬 Yo‘riqnoma media in Super-Admin panel and all media uploader buttons', () => {
    const adminPanelJson = JSON.stringify(getAdminMainPanelKeyboard().inline_keyboard);
    expect(adminPanelJson).toContain('🎬 Yo‘riqnoma media');
    expect(adminPanelJson).toContain('adm:onb_media');

    const mediaPanelJson = JSON.stringify(getOnboardingMediaPanelKeyboard().inline_keyboard);
    expect(mediaPanelJson).toContain('🎥 Kirish videosi');
    expect(mediaPanelJson).toContain('🖼 Slayd 1');
    expect(mediaPanelJson).toContain('🖼 Slayd 2');
    expect(mediaPanelJson).toContain('🖼 Slayd 3');
    expect(mediaPanelJson).toContain('🖼 Slayd 4');
    expect(mediaPanelJson).toContain('👀 Sinab ko‘rish (Preview)');
    expect(mediaPanelJson).toContain('🗑 Tozalash');
  });
});
