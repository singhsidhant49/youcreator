import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createEditorialAudioPlan,
  verifyEditorialAudioPlan,
  createSpeechIntervalsFromWords,
  measurePcmAudioLoudness,
  calibrateEditorialAudioPlan,
  type EditorialAudioInput,
} from "./editorial-audio-plan.js";

import {
  decibelsToLinear,
  evaluateMusicGain,
} from "./editorial-audio-envelope.js";

const H = "a".repeat(64);

function fixture(): EditorialAudioInput {
  return {
    version: 1,
    profile: "documentary",
    fps: 30,
    totalFrames: 900,
    narrationSha256: H,
    speechIntervals: [
      {
        startFrame: 60,
        endFrameExclusive: 180,
      },
      {
        startFrame: 300,
        endFrameExclusive: 480,
      },
    ],
    music: {
      assetId: "licensed-bed-01",
      sha256: H,
      durationSeconds: 60,
      licenseId: "commercial-license-01",
      commercialUseVerified: true,
      attributionRequired: false,
    },
  };
}

describe("M10.4 editorial audio", () => {
  it("creates deterministic audio plans", () => {
    const input = fixture();

    expect(createEditorialAudioPlan(input))
      .toEqual(createEditorialAudioPlan(input));
  });

  it("verifies canonical plan identity", () => {
    const plan = createEditorialAudioPlan(
      fixture(),
    );

    expect(verifyEditorialAudioPlan(plan))
      .toEqual(plan);
  });

  it("rejects modified gain values", () => {
    const plan = createEditorialAudioPlan(
      fixture(),
    );

    expect(() =>
      verifyEditorialAudioPlan({
        ...plan,
        musicBaseGainDb: 0,
      }),
    ).toThrow(
      "M10.4 audio plan identity mismatch",
    );
  });

  it("rejects overlapping speech intervals", () => {
    const input = fixture();

    input.speechIntervals[1] = {
      startFrame: 170,
      endFrameExclusive: 250,
    };

    expect(() =>
      createEditorialAudioPlan(input),
    ).toThrow(
      "M10.4 invalid speech timing intervals",
    );
  });

  it("rejects unverified music licensing", () => {
    const input = fixture();

    input.music = {
      ...input.music!,
      commercialUseVerified: false,
    } as unknown as EditorialAudioInput["music"];

    expect(() =>
      createEditorialAudioPlan(input),
    ).toThrow();
  });

  it("supports narration-only videos", () => {
    const input = fixture();
    input.music = null;

    const plan = createEditorialAudioPlan(input);

    expect(plan.musicEnabled).toBe(false);
    expect(evaluateMusicGain(plan, 100)).toBe(0);
  });

  it("ducks music beneath speech", () => {
    const plan = createEditorialAudioPlan(
      fixture(),
    );

    const speech = evaluateMusicGain(
      plan,
      100,
    );

    const gap = evaluateMusicGain(
      plan,
      240,
    );

    expect(speech).toBeLessThan(gap);
  });

  it("fades music at the start and end", () => {
    const plan = createEditorialAudioPlan(
      fixture(),
    );

    expect(evaluateMusicGain(plan, 0)).toBe(0);
    expect(evaluateMusicGain(plan, 899)).toBe(0);
    expect(evaluateMusicGain(plan, 220))
      .toBeGreaterThan(0);
  });

  it("uses different profile treatments", () => {
    const documentary = createEditorialAudioPlan(
      fixture(),
    );

    const story = createEditorialAudioPlan({
      ...fixture(),
      profile: "story",
    });

    expect(story.duckingReductionDb)
      .not.toBe(documentary.duckingReductionDb);
  });

  it("converts decibels to linear amplitude", () => {
    expect(decibelsToLinear(0)).toBeCloseTo(1);
    expect(decibelsToLinear(-20)).toBeCloseTo(0.1);
  });

  it("rejects invalid audio frames", () => {
    const plan = createEditorialAudioPlan(
      fixture(),
    );

    expect(() =>
      evaluateMusicGain(plan, -1),
    ).toThrow("M10.4 invalid audio frame");
  });

  it("converts word timings into smooth speech intervals", () => {
    const words = [
      { startSeconds: 1.0, endSeconds: 1.3 },
      { startSeconds: 1.4, endSeconds: 1.8 }, // gap 0.1s -> merged
      { startSeconds: 3.0, endSeconds: 3.5 }, // gap 1.2s -> separate
    ];

    const intervals = createSpeechIntervalsFromWords(words, 30, 150, 0.35);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]!.startFrame).toBe(30);
    expect(intervals[0]!.endFrameExclusive).toBe(54);
    expect(intervals[1]!.startFrame).toBe(90);
    expect(intervals[1]!.endFrameExclusive).toBe(105);
  });

  it("measures audio loudness metrics from PCM samples", () => {
    // Generate a simple PCM buffer
    const pcm = Buffer.alloc(1000 * 2);
    for (let i = 0; i < 1000; i++) {
      pcm.writeInt16LE(Math.round(16384 * Math.sin(i / 10)), i * 2);
    }

    const metrics = measurePcmAudioLoudness(pcm);
    expect(metrics.rmsDbfs).toBeLessThan(0);
    expect(metrics.peakDbfs).toBeLessThanOrEqual(0);
    expect(metrics.peakDbfs).toBeGreaterThan(metrics.rmsDbfs);
  });

  it("calibrates music gain relative to actual speech loudness", () => {
    const plan = createEditorialAudioPlan(fixture());

    // Soft narrator (-24 dBFS) -> music base gain should drop
    const calibrated = calibrateEditorialAudioPlan(plan, {
      narrationRmsDbfs: -24,
      musicRmsDbfs: -14,
    });

    expect(calibrated.musicBaseGainDb).toBeLessThan(plan.musicBaseGainDb);
    expect(calibrated.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(calibrated.planHash).not.toBe(plan.planHash);
  });
});
