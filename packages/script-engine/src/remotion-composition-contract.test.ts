import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  NarrationWordAlignmentSchema,
} from "./narration-alignment-contract.js";

import type {
  AudioAlignedVisualPackage,
} from "./audio-aligned-visual-reconstruction.js";

import {
  createRemotionComposition,
  verifyRemotionComposition,
  type CreateRemotionCompositionInput,
} from "./remotion-composition-contract.js";

const JOB_ID = "job-m7-composition";
const AUDIO_HASH = "a".repeat(64);
const SCRIPT_HASH = "b".repeat(64);

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function fixture(): CreateRemotionCompositionInput {
  const alignmentPayload = {
    version: 1 as const,
    jobId: JOB_ID,
    audioSha256: AUDIO_HASH,
    scriptHash: SCRIPT_HASH,
    sampleRate: 24000,
    sampleFrames: 72000,
    words: [
      {
        tokenIndex: 0,
        index: 0,
        word: "Hello",
        text: "Hello",
        startSample: 984,
        endSampleExclusive: 24000,
        startSeconds: 0.041,
        endSeconds: 1,
      },
      {
        tokenIndex: 1,
        index: 1,
        word: "world",
        text: "world",
        startSample: 27072,
        endSampleExclusive: 66384,
        startSeconds: 1.128,
        endSeconds: 2.766,
      },
    ],
  };

  const normalizedAlignment = NarrationWordAlignmentSchema.omit({
    alignmentHash: true,
  }).parse(alignmentPayload);

  const alignment =
    NarrationWordAlignmentSchema.parse({
      ...normalizedAlignment,
      alignmentHash: hash(normalizedAlignment),
    });

  const visualPayload = {
    version: 1 as const,
    jobId: JOB_ID,

    productionPackageHash: "c".repeat(64),
    mediaManifestHash: "d".repeat(64),
    bindingPackageHash: "e".repeat(64),
    motionPackageHash: "f".repeat(64),
    geometryPackageHash: "1".repeat(64),

    fps: 30,
    frameWidth: 1920,
    frameHeight: 1080,
    totalFrames: 90,
    shotCount: 2,

    shots: [
      {
        version: 1 as const,
        shotId: "shot-001",
        shotIndex: 0,
        bindingHash: "2".repeat(64),
        assetSha256: "3".repeat(64),
        assetId: "asset-001",
        assetPath: "/assets/asset-001.png",
        sourceWidth: 1920,
        sourceHeight: 1080,
        startFrame: 0,
        endFrameExclusive: 34,
        durationFrames: 34,
        fit: "contain" as const,
        motion: "static" as const,
        startCrop: null,
        endCrop: null,
      },
      {
        version: 1 as const,
        shotId: "shot-002",
        shotIndex: 1,
        bindingHash: "4".repeat(64),
        assetSha256: "5".repeat(64),
        assetId: "asset-002",
        assetPath: "/assets/asset-002.png",
        sourceWidth: 1920,
        sourceHeight: 1080,
        startFrame: 34,
        endFrameExclusive: 90,
        durationFrames: 56,
        fit: "contain" as const,
        motion: "static" as const,
        startCrop: null,
        endCrop: null,
      },
    ],
  };

  const visual = {
    ...visualPayload,
    visualPackageHash: hash(visualPayload),
  };

  const m6Payload = {
    version: 1 as const,
    jobId: JOB_ID,

    contractHash: "6".repeat(64),
    m5VisualPackageHash: "7".repeat(64),
    framePlanHash: "8".repeat(64),

    audioSha256: AUDIO_HASH,
    scriptHash: SCRIPT_HASH,
    alignmentHash: alignment.alignmentHash,

    motionPackageHash:
      visual.motionPackageHash,

    geometryPackageHash:
      visual.geometryPackageHash,

    visual,
  };

  const m6: AudioAlignedVisualPackage = {
    ...m6Payload,
    audioAlignedVisualHash: hash(m6Payload),
  };

  return {
    visual: m6,
    alignment,
    audio: {
      format: "wav_pcm_s16le",
      path: "/audio/narration.wav",
      sha256: AUDIO_HASH,
      sampleRate: 24000,
      sampleFrames: 72000,
      channels: 1,
      bitsPerSample: 16,
    },
  };
}

describe("M7 canonical Remotion composition", () => {
  it("creates the canonical output specification", () => {
    const result =
      createRemotionComposition(fixture());

    expect(result.compositionId).toBe(
      "YouCreatorNarratedV1",
    );

    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.fps).toBe(30);
    expect(result.totalFrames).toBe(90);
    expect(result.shotCount).toBe(2);
  });

  it("preserves exact M6 frame boundaries", () => {
    const result =
      createRemotionComposition(fixture());

    expect(
      result.shots.map((shot) => [
        shot.startFrame,
        shot.endFrameExclusive,
      ]),
    ).toEqual([
      [0, 34],
      [34, 90],
    ]);
  });

  it("preserves verified media identities", () => {
    const input = fixture();

    const result =
      createRemotionComposition(input);

    expect(
      result.shots.map((shot) => ({
        id: shot.assetId,
        sha256: shot.assetSha256,
        path: shot.assetPath,
      })),
    ).toEqual(
      input.visual.visual.shots.map((shot) => ({
        id: shot.assetId,
        sha256: shot.assetSha256,
        path: shot.assetPath,
      })),
    );
  });

  it("includes exact word-level alignment", () => {
    const input = fixture();

    const result =
      createRemotionComposition(input);

    expect(result.words).toEqual(
      input.alignment.words,
    );

    expect(result.alignmentHash).toBe(
      input.alignment.alignmentHash,
    );
  });

  it("is deterministic and reconstructable", () => {
    const input = fixture();

    const result =
      createRemotionComposition(input);

    expect(
      verifyRemotionComposition(result, input),
    ).toEqual(result);

    expect(
      createRemotionComposition(input),
    ).toEqual(result);
  });

  it("rejects a different narration WAV", () => {
    const input = fixture();

    input.audio.sha256 = "9".repeat(64);

    expect(() =>
      createRemotionComposition(input),
    ).toThrow(
      "M7 composition audio identity mismatch",
    );
  });

  it("rejects mismatched audio duration", () => {
    const input = fixture();

    input.audio.sampleFrames = 48000;

    expect(() =>
      createRemotionComposition(input),
    ).toThrow(
      "M7 composition WAV duration mismatch",
    );
  });

  it("rejects modified source visual metadata", () => {
    const input = fixture();

    input.visual.visual.shots[0]!.endFrameExclusive = 35;

    expect(() =>
      createRemotionComposition(input),
    ).toThrow(
      "M7 package integrity mismatch: audioAlignedVisualHash",
    );
  });

  it("rejects a tampered saved composition", () => {
    const input = fixture();

    const original =
      createRemotionComposition(input);

    const tampered = structuredClone(original);

    tampered.shots[0]!.durationFrames = 33;

    expect(() =>
      verifyRemotionComposition(
        tampered,
        input,
      ),
    ).toThrow(
      "M7 composition canonical reconstruction mismatch",
    );
  });
});
