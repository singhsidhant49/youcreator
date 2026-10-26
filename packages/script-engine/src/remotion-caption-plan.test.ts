import { describe, expect, it } from "vitest";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  createRemotionCaptionPlan,
  sampleIntervalToFrames,
  verifyRemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import {
  findActiveCaptionCue,
  findActiveWordIndex,
} from "./remotion-captions.js";

const H = "a".repeat(64);

function fixture(): RemotionComposition {
  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId: "caption-job",
    productionPackageHash: H,
    m6VisualHash: H,
    visualPackageHash: H,
    framePlanHash: H,
    scriptHash: H,
    alignmentHash: H,
    audioSha256: H,
    compositionHash: H,

    fps: 30,
    width: 1920,
    height: 1080,
    totalFrames: 90,
    shotCount: 1,

    audio: {
      format: "wav_pcm_s16le",
      path: "/audio/narration.wav",
      sha256: H,
      sampleRate: 24000,
      sampleFrames: 72000,
      channels: 1,
      bitsPerSample: 16,
    },

    shots: [{
      version: 1,
      shotId: "shot-1",
      shotIndex: 0,
      bindingHash: H,
      assetSha256: H,
      assetId: "asset-1",
      assetPath: "/media/image.png",
      sourceWidth: 1920,
      sourceHeight: 1080,
      startFrame: 0,
      endFrameExclusive: 90,
      durationFrames: 90,
      fit: "contain",
      motion: "static",
      startCrop: null,
      endCrop: null,
    }],

    words: [
      {
        tokenIndex: 0,
        index: 0,
        word: "Hello",
        text: "Hello",
        startSample: 0,
        endSampleExclusive: 12000,
        startSeconds: 0,
        endSeconds: 0.5,
      },
      {
        tokenIndex: 1,
        index: 1,
        word: "there.",
        text: "there.",
        startSample: 12000,
        endSampleExclusive: 24000,
        startSeconds: 0.5,
        endSeconds: 1,
      },
      {
        tokenIndex: 2,
        index: 2,
        word: "Welcome",
        text: "Welcome",
        startSample: 36000,
        endSampleExclusive: 48000,
        startSeconds: 1.5,
        endSeconds: 2,
      },
      {
        tokenIndex: 3,
        index: 3,
        word: "back!",
        text: "back!",
        startSample: 48000,
        endSampleExclusive: 60000,
        startSeconds: 2,
        endSeconds: 2.5,
      },
    ],
  };
}

describe("M7.4 canonical caption plan", () => {
  it("maps exact sample intervals to frames", () => {
    expect(
      sampleIntervalToFrames(
        12000,
        24000,
        24000,
        30,
        90,
      ),
    ).toEqual({
      startFrame: 15,
      endFrameExclusive: 30,
    });
  });

  it("preserves subframe words", () => {
    expect(
      sampleIntervalToFrames(
        100,
        200,
        24000,
        30,
        90,
      ),
    ).toEqual({
      startFrame: 0,
      endFrameExclusive: 1,
    });
  });

  it("groups sentences deterministically", () => {
    const plan =
      createRemotionCaptionPlan(fixture());

    expect(plan.cues).toHaveLength(2);

    expect(
      plan.cues.map((cue) =>
        cue.words.map((w) => w.text),
      ),
    ).toEqual([
      ["Hello", "there."],
      ["Welcome", "back!"],
    ]);
  });

  it("preserves leading and internal silence", () => {
    const plan =
      createRemotionCaptionPlan(fixture());

    expect(
      findActiveCaptionCue(plan.cues, 35),
    ).toBeNull();

    expect(
      findActiveCaptionCue(plan.cues, 44),
    ).toBeNull();
  });

  it("highlights the currently spoken word", () => {
    const plan =
      createRemotionCaptionPlan(fixture());

    const cue = plan.cues[0]!;

    expect(
      findActiveWordIndex(cue, 5),
    ).toBe(0);

    expect(
      findActiveWordIndex(cue, 20),
    ).toBe(1);
  });

  it("returns no cue after the final word", () => {
    const plan =
      createRemotionCaptionPlan(fixture());

    expect(
      findActiveCaptionCue(plan.cues, 89),
    ).toBeNull();
  });

  it("reconstructs identical caption plans", () => {
    const composition = fixture();

    const plan =
      createRemotionCaptionPlan(composition);

    expect(
      verifyRemotionCaptionPlan(
        plan,
        composition,
      ),
    ).toEqual(plan);
  });

  it("rejects tampered caption records", () => {
    const composition = fixture();

    const plan =
      createRemotionCaptionPlan(composition);

    const changed = structuredClone(plan);

    changed.cues[0]!.words[0]!.text =
      "Tampered";

    expect(() =>
      verifyRemotionCaptionPlan(
        changed,
        composition,
      ),
    ).toThrow(
      "M7 caption plan reconstruction mismatch",
    );
  });

  it("rejects invalid grouping options", () => {
    expect(() =>
      createRemotionCaptionPlan(
        fixture(),
        { maxWordsPerCue: 0 },
      ),
    ).toThrow(
      "Invalid caption grouping options",
    );
  });

  it("rejects intervals outside the video", () => {
    expect(() =>
      sampleIntervalToFrames(
        72000,
        73000,
        24000,
        30,
        90,
      ),
    ).toThrow(
      "Caption frame interval exceeds video",
    );
  });
});
