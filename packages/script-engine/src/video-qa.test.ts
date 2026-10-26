import { describe, expect, it } from "vitest";
import sharp from "sharp";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  createVideoQaFramePlan,
  verifyVideoQaFramePlan,
} from "./video-qa-frame-plan.js";

import {
  analyzeVideoQaFrames,
  meanPixelDifference,
} from "./video-qa-frame-analyzer.js";

const H = "a".repeat(64);

function fixture(
  motion: "static" | "zoom_in" = "static",
): RemotionComposition {
  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId: "m8-qa-job",
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
    shotCount: 2,
    audio: {
      format: "wav_pcm_s16le",
      path: "/tmp/narration.wav",
      sha256: H,
      sampleRate: 24000,
      sampleFrames: 72000,
      channels: 1,
      bitsPerSample: 16,
    },
    shots: [
      {
        version: 1,
        shotId: "shot-1",
        shotIndex: 0,
        bindingHash: H,
        assetSha256: H,
        assetId: "asset-1",
        assetPath: "/tmp/image-1.png",
        sourceWidth: 1920,
        sourceHeight: 1080,
        startFrame: 0,
        endFrameExclusive: 60,
        durationFrames: 60,
        fit: "contain",
        motion,
        startCrop: null,
        endCrop: null,
      },
      {
        version: 1,
        shotId: "shot-2",
        shotIndex: 1,
        bindingHash: H,
        assetSha256: H,
        assetId: "asset-2",
        assetPath: "/tmp/image-2.png",
        sourceWidth: 1920,
        sourceHeight: 1080,
        startFrame: 60,
        endFrameExclusive: 90,
        durationFrames: 30,
        fit: "contain",
        motion: "static",
        startCrop: null,
        endCrop: null,
      },
    ],
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
    ],
  };
}

async function image(
  color: string,
): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 36,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

describe("M8.1 video QA", () => {
  it("samples first middle and final frames", () => {
    const plan =
      createVideoQaFramePlan(fixture());

    const frames = plan.samples.map(
      (sample) => sample.frame,
    );

    expect(frames).toContain(0);
    expect(frames).toContain(29);
    expect(frames).toContain(59);
    expect(frames).toContain(60);
    expect(frames).toContain(89);
  });

  it("creates a deterministic plan", () => {
    const manifest = fixture();
    const plan =
      createVideoQaFramePlan(manifest);

    expect(
      verifyVideoQaFramePlan(
        plan,
        manifest,
      ),
    ).toEqual(plan);
  });

  it("rejects tampered sampling plans", () => {
    const manifest = fixture();
    const plan =
      createVideoQaFramePlan(manifest);

    const changed = structuredClone(plan);
    changed.samples[0]!.frame = 5;

    expect(() =>
      verifyVideoQaFramePlan(
        changed,
        manifest,
      ),
    ).toThrow(
      "M8 QA frame plan reconstruction mismatch",
    );
  });

  it("identifies black frames", async () => {
    const manifest = fixture();
    const plan =
      createVideoQaFramePlan(manifest);

    const black = await image("#000000");

    const result = await analyzeVideoQaFrames(
      manifest,
      plan,
      plan.samples.map((sample) => ({
        frame: sample.frame,
        png: black,
      })),
    );

    expect(
      result.findings.some(
        (finding) =>
          finding.code === "BLACK_FRAME",
      ),
    ).toBe(true);
  });

  it("does not call white frames black", async () => {
    const manifest = fixture();
    const plan =
      createVideoQaFramePlan(manifest);

    const white = await image("#ffffff");

    const result = await analyzeVideoQaFrames(
      manifest,
      plan,
      plan.samples.map((sample) => ({
        frame: sample.frame,
        png: white,
      })),
    );

    expect(result.findings).toEqual([]);
  });

  it("exempts static shots from frozen-motion warnings", async () => {
    const manifest = fixture("static");
    const plan =
      createVideoQaFramePlan(manifest);

    const white = await image("#ffffff");

    const result = await analyzeVideoQaFrames(
      manifest,
      plan,
      plan.samples.map((sample) => ({
        frame: sample.frame,
        png: white,
      })),
    );

    expect(
      result.findings.some(
        (finding) =>
          finding.code === "POSSIBLE_FROZEN_MOTION",
      ),
    ).toBe(false);
  });

  it("detects identical frames in expected moving shots", async () => {
    const manifest = fixture("zoom_in");
    const plan =
      createVideoQaFramePlan(manifest);

    const white = await image("#ffffff");

    const result = await analyzeVideoQaFrames(
      manifest,
      plan,
      plan.samples.map((sample) => ({
        frame: sample.frame,
        png: white,
      })),
    );

    expect(
      result.findings.some(
        (finding) =>
          finding.code === "POSSIBLE_FROZEN_MOTION",
      ),
    ).toBe(true);
  });

  it("calculates pixel difference correctly", () => {
    const a = Buffer.from([0, 0, 0]);
    const b = Buffer.from([255, 255, 255]);

    expect(
      meanPixelDifference(a, b),
    ).toBe(255);

    expect(
      meanPixelDifference(a, a),
    ).toBe(0);
  });

  it("rejects missing decoded frames", async () => {
    const manifest = fixture();
    const plan =
      createVideoQaFramePlan(manifest);

    await expect(
      analyzeVideoQaFrames(
        manifest,
        plan,
        [],
      ),
    ).rejects.toThrow(
      "M8 decoded frame coverage mismatch",
    );
  });

  it("rejects unsupported sampling limits", () => {
    expect(() =>
      createVideoQaFramePlan(
        fixture(),
        { maxSamples: 1 },
      ),
    ).toThrow(
      "M8 QA frame sample limit exceeded",
    );
  });
});
