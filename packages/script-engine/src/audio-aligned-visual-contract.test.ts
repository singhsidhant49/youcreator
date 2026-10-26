import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
  RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import type {
  AudioAlignedFramePlan,
} from "./audio-aligned-frame-plan.js";

import {
  createAudioAlignedVisualContract,
  verifyAudioAlignedVisualContract,
} from "./audio-aligned-visual-contract.js";

const JOB_ID = "job-m6-visual-contract";

const M3_HASH = "a".repeat(64);
const MEDIA_HASH = "b".repeat(64);
const AUDIO_HASH = "c".repeat(64);

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function fixture(): {
  visual: RendererReadyVisualPackage;
  framePlan: AudioAlignedFramePlan;
} {
  const visualPayload = {
    version: 1 as const,
    jobId: JOB_ID,

    productionPackageHash: M3_HASH,
    mediaManifestHash: MEDIA_HASH,
    bindingPackageHash: "d".repeat(64),
    motionPackageHash: "e".repeat(64),
    geometryPackageHash: "f".repeat(64),

    fps: 30,
    frameWidth: 1920,
    frameHeight: 1080,

    // Deliberately estimated M5 timing.
    totalFrames: 120,
    shotCount: 2,

    shots: [
      {
        version: 1 as const,
        shotId: "shot-001",
        shotIndex: 0,

        bindingHash: "1".repeat(64),
        assetSha256: "2".repeat(64),
        assetId: "asset-001",
        assetPath: "/objects/asset-001.png",

        sourceWidth: 1280,
        sourceHeight: 720,

        startFrame: 0,
        endFrameExclusive: 60,
        durationFrames: 60,

        fit: "contain" as const,
        motion: "static" as const,
        startCrop: null,
        endCrop: null,
      },
      {
        version: 1 as const,
        shotId: "shot-002",
        shotIndex: 1,

        bindingHash: "3".repeat(64),
        assetSha256: "4".repeat(64),
        assetId: "asset-002",
        assetPath: "/objects/asset-002.png",

        sourceWidth: 1280,
        sourceHeight: 720,

        startFrame: 60,
        endFrameExclusive: 120,
        durationFrames: 60,

        fit: "contain" as const,
        motion: "static" as const,
        startCrop: null,
        endCrop: null,
      },
    ],
  };

  const framePlanPayload = {
    version: 1 as const,
    jobId: JOB_ID,

    productionPackageHash: M3_HASH,
    scriptHash: "5".repeat(64),
    audioSha256: AUDIO_HASH,
    alignmentHash: "6".repeat(64),
    anchorPackageHash: "7".repeat(64),
    sampleTimelineHash: "8".repeat(64),

    sampleRate: 24000,
    totalSamples: 72000,

    fps: 30,
    totalFrames: 90,
    shotCount: 2,

    // Real M6 audio-aligned timing.
    shots: [
      {
        version: 1 as const,
        shotId: "shot-001",
        shotIndex: 0,

        startTokenIndex: 0,
        endTokenIndexExclusive: 3,

        startSample: 0,
        endSampleExclusive: 27072,

        startFrame: 0,
        endFrameExclusive: 34,
        durationFrames: 34,
      },
      {
        version: 1 as const,
        shotId: "shot-002",
        shotIndex: 1,

        startTokenIndex: 3,
        endTokenIndexExclusive: 7,

        startSample: 27072,
        endSampleExclusive: 72000,

        startFrame: 34,
        endFrameExclusive: 90,
        durationFrames: 56,
      },
    ],
  };

  return {
    visual: {
      ...visualPayload,
      visualPackageHash: hash(visualPayload),
    },

    framePlan: {
      ...framePlanPayload,
      framePlanHash: hash(framePlanPayload),
    },
  };
}

describe("M6 audio-aligned visual contract", () => {
  it("uses actual M6 timing instead of estimated M5 timing", () => {
    const result =
      createAudioAlignedVisualContract(
        fixture(),
      );

    expect(result.totalFrames).toBe(90);

    expect(result.shots[0]).toMatchObject({
      shotId: "shot-001",
      startFrame: 0,
      endFrameExclusive: 34,
      durationFrames: 34,
    });

    expect(result.shots[1]).toMatchObject({
      shotId: "shot-002",
      startFrame: 34,
      endFrameExclusive: 90,
      durationFrames: 56,
    });
  });

  it("preserves M5 media identities", () => {
    const input = fixture();

    const result =
      createAudioAlignedVisualContract(input);

    for (
      let index = 0;
      index < result.shots.length;
      index++
    ) {
      expect(result.shots[index]).toMatchObject({
        assetId:
          input.visual.shots[index]!.assetId,

        assetSha256:
          input.visual.shots[index]!.assetSha256,

        bindingHash:
          input.visual.shots[index]!.bindingHash,

        sourceWidth:
          input.visual.shots[index]!.sourceWidth,

        sourceHeight:
          input.visual.shots[index]!.sourceHeight,
      });
    }
  });

  it("binds M5 and M6 package identities", () => {
    const input = fixture();

    const result =
      createAudioAlignedVisualContract(input);

    expect(result.m5VisualPackageHash).toBe(
      input.visual.visualPackageHash,
    );

    expect(result.m6FramePlanHash).toBe(
      input.framePlan.framePlanHash,
    );

    expect(result.audioSha256).toBe(
      input.framePlan.audioSha256,
    );

    expect(result.productionPackageHash).toBe(
      M3_HASH,
    );
  });

  it("is deterministic and supports reconstruction verification", () => {
    const input = fixture();

    const result =
      createAudioAlignedVisualContract(input);

    expect(
      createAudioAlignedVisualContract(input),
    ).toEqual(result);

    expect(
      verifyAudioAlignedVisualContract(
        result,
        input,
      ),
    ).toEqual(result);
  });

  it("rejects mismatched M3 package identity", () => {
    const input = fixture();

    input.framePlan.productionPackageHash =
      "9".repeat(64);

    const {
      framePlanHash: _old,
      ...payload
    } = input.framePlan;

    input.framePlan.framePlanHash =
      hash(payload);

    expect(() =>
      createAudioAlignedVisualContract(input),
    ).toThrow(
      "M6 visual contract M3 identity mismatch",
    );
  });

  it("rejects mismatched shot identities", () => {
    const input = fixture();

    input.framePlan.shots[1]!.shotId =
      "wrong-shot";

    const {
      framePlanHash: _old,
      ...payload
    } = input.framePlan;

    input.framePlan.framePlanHash =
      hash(payload);

    expect(() =>
      createAudioAlignedVisualContract(input),
    ).toThrow(
      "M6 visual contract shot identity mismatch",
    );
  });

  it("rejects corrupted upstream package hashes", () => {
    const input = fixture();

    input.visual.visualPackageHash =
      "0".repeat(64);

    expect(() =>
      createAudioAlignedVisualContract(input),
    ).toThrow(
      "M6 visual contract M5 integrity mismatch",
    );
  });

  it("rejects tampered persisted contracts", () => {
    const input = fixture();

    const result =
      createAudioAlignedVisualContract(input);

    const tampered = structuredClone(result);

    tampered.shots[0]!.endFrameExclusive += 1;

    expect(() =>
      verifyAudioAlignedVisualContract(
        tampered,
        input,
      ),
    ).toThrow(
      "M6 visual contract canonical reconstruction mismatch",
    );
  });
});
