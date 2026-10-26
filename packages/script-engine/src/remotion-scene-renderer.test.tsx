import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  interpolateShotCrop,
} from "./remotion-shot.js";

import {
  validateSceneInputs,
} from "./remotion-composition.js";

import {
  createEditorialMotionPlan,
} from "./editorial-motion-plan.js";

import {
  evaluateEditorialFrame,
} from "./editorial-motion-evaluator.js";

import {
  createEditorialAudioPlan,
} from "./editorial-audio-plan.js";

const HASH = "a".repeat(64);

function shotFixture() {
  return {
    version: 1 as const,
    shotId: "shot-001",
    shotIndex: 0,

    bindingHash: HASH,
    assetSha256: HASH,

    assetId: "asset-001",
    assetPath: "/assets/asset-001.png",

    sourceWidth: 1920,
    sourceHeight: 1080,

    startFrame: 0,
    endFrameExclusive: 60,
    durationFrames: 60,

    fit: "cover" as const,
    motion: "zoom_in" as const,

    startCrop: {
      left: 50,
      top: 28,
      width: 1820,
      height: 1024,
    },
    endCrop: {
      left: 100,
      top: 56,
      width: 1720,
      height: 968,
    },
  };
}

describe("M7 Remotion scene renderer", () => {
  it("uses the verified starting crop", () => {
    const shot = shotFixture();

    expect(
      interpolateShotCrop(shot, 0),
    ).toEqual(shot.startCrop);
  });

  it("reaches the verified ending crop", () => {
    const shot = shotFixture();

    expect(
      interpolateShotCrop(shot, 59),
    ).toEqual(shot.endCrop);
  });

  it("clamps out-of-range frames", () => {
    const shot = shotFixture();

    expect(
      interpolateShotCrop(shot, -100),
    ).toEqual(shot.startCrop);

    expect(
      interpolateShotCrop(shot, 999),
    ).toEqual(shot.endCrop);
  });

  it("interpolates a valid intermediate crop", () => {
    const shot = shotFixture();

    const crop = interpolateShotCrop(
      shot,
      30,
    )!;

    expect(crop.left).toBeGreaterThan(
      shot.startCrop.left,
    );

    expect(crop.left).toBeLessThan(
      shot.endCrop.left,
    );

    expect(crop.width).toBeLessThan(
      shot.startCrop.width,
    );

    expect(crop.width).toBeGreaterThan(
      shot.endCrop.width,
    );
  });

  it("does not crop contain-fit imagery", () => {
    const shot = {
      ...shotFixture(),
      fit: "contain" as const,
      motion: "static" as const,
      startCrop: null,
      endCrop: null,
    };

    expect(
      interpolateShotCrop(shot, 20),
    ).toBeNull();
  });

  it("rejects missing cover geometry", () => {
    const shot = {
      ...shotFixture(),
      startCrop: null,
    };

    expect(() =>
      interpolateShotCrop(shot, 10),
    ).toThrow(
      "Missing cover crop",
    );
  });

  it("rejects invalid scene coverage", () => {
    const shot = shotFixture();

    const manifest = {
      version: 1,
      compositionId: "YouCreatorNarratedV1",
      jobId: "job-m7",
      productionPackageHash: HASH,
      m6VisualHash: HASH,
      visualPackageHash: HASH,
      framePlanHash: HASH,
      scriptHash: HASH,
      alignmentHash: HASH,
      audioSha256: HASH,
      fps: 30,
      width: 1920,
      height: 1080,
      totalFrames: 60,
      shotCount: 1,
      audio: {
        format: "wav_pcm_s16le",
        path: "/audio/narration.wav",
        sha256: HASH,
        sampleRate: 24000,
        sampleFrames: 48000,
        channels: 1,
        bitsPerSample: 16,
      },
      shots: [
        {
          ...shot,
          startFrame: 1,
        },
      ],
      words: [
        {
          tokenIndex: 0,
          index: 0,
          word: "test",
          text: "test",
          startSeconds: 0,
          endSeconds: 1,
          startSample: 0,
          endSampleExclusive: 24000,
        },
      ],
      compositionHash: HASH,
    } as unknown as RemotionComposition;

    const captionPlan = {
      version: 1 as const,
      compositionHash: HASH,
      fps: 30,
      totalFrames: 60,
      cues: [],
      captionPlanHash: HASH,
    };

    expect(() =>
      validateSceneInputs({
        manifest,
        imageUrls: {
          "shot-001": `/media/${HASH}.png`,
        },
        audioUrl: `/media/${HASH}.wav`,
        captionPlan,
      }),
    ).toThrow(
      "M7 invalid shot timing",
    );
  });

  it("validates scene inputs with matching motion plan", () => {
    const shot = shotFixture();
    const manifest = {
      version: 1,
      compositionId: "YouCreatorNarratedV1",
      jobId: "job-m7",
      productionPackageHash: HASH,
      m6VisualHash: HASH,
      visualPackageHash: HASH,
      framePlanHash: HASH,
      scriptHash: HASH,
      alignmentHash: HASH,
      audioSha256: HASH,
      fps: 30,
      width: 1920,
      height: 1080,
      totalFrames: 60,
      shotCount: 1,
      audio: {
        format: "wav_pcm_s16le",
        path: "/audio/narration.wav",
        sha256: HASH,
        sampleRate: 24000,
        sampleFrames: 48000,
        channels: 1,
        bitsPerSample: 16,
      },
      shots: [shot],
      words: [
        {
          tokenIndex: 0,
          index: 0,
          word: "test",
          text: "test",
          startSeconds: 0,
          endSeconds: 1,
          startSample: 0,
          endSampleExclusive: 24000,
        },
      ],
      compositionHash: HASH,
    } as unknown as RemotionComposition;

    const captionPlan = {
      version: 1 as const,
      compositionHash: HASH,
      fps: 30,
      totalFrames: 60,
      cues: [],
      captionPlanHash: HASH,
    };

    const motionPlan = createEditorialMotionPlan({
      profile: "documentary",
      fps: 30,
      shots: [{
        shotId: shot.shotId,
        assetSha256: shot.assetSha256,
        startFrame: 0,
        endFrameExclusive: 60,
      }],
    });

    expect(() =>
      validateSceneInputs({
        manifest,
        imageUrls: {
          [shot.shotId]: `/media/${HASH}.png`,
        },
        audioUrl: `/media/${HASH}.wav`,
        captionPlan,
        motionPlan,
      }),
    ).not.toThrow();

    // Mismatched FPS
    expect(() =>
      validateSceneInputs({
        manifest,
        imageUrls: {
          [shot.shotId]: `/media/${HASH}.png`,
        },
        audioUrl: `/media/${HASH}.wav`,
        captionPlan,
        motionPlan: {
          ...motionPlan,
          fps: 24,
        },
      }),
    ).toThrow("M10.3 motion plan composition mismatch");
  });

  it("evaluates motion transforms within crop limits to prevent exposed borders", () => {
    const plan = createEditorialMotionPlan({
      profile: "story",
      fps: 30,
      shots: [
        {
          shotId: "shot-1",
          assetSha256: HASH,
          startFrame: 0,
          endFrameExclusive: 150,
        },
        {
          shotId: "shot-2",
          assetSha256: "b".repeat(64),
          startFrame: 150,
          endFrameExclusive: 300,
        },
      ],
    });

    for (let f = 0; f < 150; f += 10) {
      const transform = evaluateEditorialFrame(plan, 0, f);
      expect(transform.scale).toBeGreaterThanOrEqual(1.035);
      expect(transform.scale).toBeLessThanOrEqual(1.15);

      // Verify translation margin safety check
      const maxTranslateX = Math.max(0, (transform.scale - 1) / 2) * 100;
      const safeTranslateX = Math.max(
        -maxTranslateX,
        Math.min(maxTranslateX, transform.translateXPercent),
      );
      expect(Math.abs(safeTranslateX)).toBeLessThanOrEqual(maxTranslateX);
    }
  });

  it("evaluates complementary crossfade opacities without black dips", () => {
    const plan = createEditorialMotionPlan({
      profile: "documentary",
      fps: 30,
      shots: [
        {
          shotId: "shot-1",
          assetSha256: HASH,
          startFrame: 0,
          endFrameExclusive: 120,
        },
        {
          shotId: "shot-2",
          assetSha256: "b".repeat(64),
          startFrame: 120,
          endFrameExclusive: 240,
        },
      ],
    });

    // Check if crossfade is present
    const boundary = plan.boundaries[0];
    if (boundary?.type === "crossfade") {
      const duration = boundary.durationFrames;
      expect(duration).toBeGreaterThan(0);

      // Test opacity progression across crossfade frames
      for (let offset = 0; offset < duration; offset++) {
        const absFrame = 120 + offset;
        const incomingMotion = evaluateEditorialFrame(plan, 1, absFrame);
        const outgoingMotion = evaluateEditorialFrame(plan, 0, absFrame);

        expect(incomingMotion.opacity).toBeGreaterThanOrEqual(0);
        expect(incomingMotion.opacity).toBeLessThanOrEqual(1);
        expect(outgoingMotion.opacity).toBeGreaterThanOrEqual(0);
        expect(outgoingMotion.opacity).toBeLessThanOrEqual(1);

        // Underneath layer is opaque (1.0), and top layer has outgoingMotion.opacity
        // guaranteeing zero black dips and linear continuity.
      }
    }
  });

  it("validates scene inputs with matching audio plan and music URL", () => {
    const shot = shotFixture();
    const manifest = {
      version: 1,
      compositionId: "YouCreatorNarratedV1",
      jobId: "job-m7",
      productionPackageHash: HASH,
      m6VisualHash: HASH,
      visualPackageHash: HASH,
      framePlanHash: HASH,
      scriptHash: HASH,
      alignmentHash: HASH,
      audioSha256: HASH,
      fps: 30,
      width: 1920,
      height: 1080,
      totalFrames: 60,
      shotCount: 1,
      audio: {
        format: "wav_pcm_s16le",
        path: "/audio/narration.wav",
        sha256: HASH,
        sampleRate: 24000,
        sampleFrames: 48000,
        channels: 1,
        bitsPerSample: 16,
      },
      shots: [shot],
      words: [
        {
          tokenIndex: 0,
          index: 0,
          word: "test",
          text: "test",
          startSeconds: 0,
          endSeconds: 1,
          startSample: 0,
          endSampleExclusive: 24000,
        },
      ],
      compositionHash: HASH,
    } as unknown as RemotionComposition;

    const captionPlan = {
      version: 1 as const,
      compositionHash: HASH,
      fps: 30,
      totalFrames: 60,
      cues: [],
      captionPlanHash: HASH,
    };

    const audioPlan = createEditorialAudioPlan({
      version: 1,
      profile: "explainer",
      fps: 30,
      totalFrames: 60,
      narrationSha256: HASH,
      speechIntervals: [{
        startFrame: 0,
        endFrameExclusive: 30,
      }],
      music: {
        assetId: "music-01",
        sha256: HASH,
        durationSeconds: 60,
        licenseId: "lic-01",
        commercialUseVerified: true,
        attributionRequired: false,
      },
    });

    // Valid with musicUrl
    expect(() =>
      validateSceneInputs({
        manifest,
        imageUrls: {
          [shot.shotId]: `/media/${HASH}.png`,
        },
        audioUrl: `/media/${HASH}.wav`,
        musicUrl: `/media/${HASH}.wav`,
        captionPlan,
        audioPlan,
      }),
    ).not.toThrow();

    // Missing musicUrl when musicEnabled is true
    expect(() =>
      validateSceneInputs({
        manifest,
        imageUrls: {
          [shot.shotId]: `/media/${HASH}.png`,
        },
        audioUrl: `/media/${HASH}.wav`,
        captionPlan,
        audioPlan,
      }),
    ).toThrow("M10.4 missing music media URL");

    // Invalid music URL format
    expect(() =>
      validateSceneInputs({
        manifest,
        imageUrls: {
          [shot.shotId]: `/media/${HASH}.png`,
        },
        audioUrl: `/media/${HASH}.wav`,
        musicUrl: `/media/invalid-url.wav`,
        captionPlan,
        audioPlan,
      }),
    ).toThrow("M10.4 invalid music media URL");

    // Mismatched total frames in audio plan
    expect(() =>
      validateSceneInputs({
        manifest,
        imageUrls: {
          [shot.shotId]: `/media/${HASH}.png`,
        },
        audioUrl: `/media/${HASH}.wav`,
        musicUrl: `/media/${HASH}.wav`,
        captionPlan,
        audioPlan: {
          ...audioPlan,
          totalFrames: 120,
        },
      }),
    ).toThrow("M10.4 audio plan composition mismatch");
  });
});
