import { describe, expect, it } from "vitest";
import sharp from "sharp";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  createVideoQaFramePlan,
} from "./video-qa-frame-plan.js";

import {
  analyzeVideoVisualVariety,
  hammingDistance64,
  imageDifferenceHash,
} from "./video-qa-visual-variety.js";

const H = "a".repeat(64);

function fixture(
  assets = ["a", "b", "c", "d"],
): RemotionComposition {
  const shots = assets.map((asset, index) => ({
    version: 1 as const,
    shotId: `shot-${index}`,
    shotIndex: index,
    bindingHash: H,
    assetSha256: asset.repeat(64),
    assetId: `asset-${index}`,
    assetPath: `/tmp/image-${index}.png`,
    sourceWidth: 1920,
    sourceHeight: 1080,
    startFrame: index * 30,
    endFrameExclusive: (index + 1) * 30,
    durationFrames: 30,
    fit: "contain" as const,
    motion: "static" as const,
    startCrop: null,
    endCrop: null,
  }));

  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId: "m8-variety-job",
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
    totalFrames: shots.length * 30,
    shotCount: shots.length,
    audio: {
      format: "wav_pcm_s16le",
      path: "/tmp/narration.wav",
      sha256: H,
      sampleRate: 24000,
      sampleFrames: shots.length * 24000,
      channels: 1,
      bitsPerSample: 16,
    },
    shots,
    words: [
      {
        tokenIndex: 0,
        word: "hello",
        startSeconds: 0,
        endSeconds: 1,
        startSample: 0,
        endSampleExclusive: 24000,
      },
    ],
  };
}

async function pattern(
  seed: number,
): Promise<Buffer> {
  const width = 90;
  const height = 80;
  const pixels = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      const value =
        ((x * 31 + y * 17 + seed * 67) ^
         ((x + seed) * (y + 3))) & 255;

      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
    }
  }

  return sharp(pixels, {
    raw: {
      width,
      height,
      channels: 3,
    },
  }).png().toBuffer();
}

async function analyze(
  manifest: RemotionComposition,
  images: readonly Buffer[],
) {
  const plan = createVideoQaFramePlan(manifest);

  const frames = plan.samples.map((sample) => ({
    frame: sample.frame,
    png: images[sample.shotIndex]!,
  }));

  return analyzeVideoVisualVariety(
    manifest,
    plan,
    frames,
  );
}

describe("M8.5 visual variety QA", () => {
  it("creates a deterministic perceptual hash", async () => {
    const bytes = await pattern(1);

    expect(
      await imageDifferenceHash(bytes),
    ).toBe(
      await imageDifferenceHash(bytes),
    );
  });

  it("calculates Hamming distance", () => {
    expect(hammingDistance64(0n, 0n)).toBe(0);
    expect(hammingDistance64(0n, 15n)).toBe(4);
    expect(
      hammingDistance64(0n, (1n << 64n) - 1n),
    ).toBe(64);
  });

  it("detects excessive exact asset reuse", async () => {
    const manifest = fixture(["a", "a", "a", "b"]);

    const images = [
      await pattern(1),
      await pattern(1),
      await pattern(1),
      await pattern(2),
    ];

    const report = await analyze(manifest, images);

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "EXACT_ASSET_REUSE",
      ),
    ).toBe(true);

    expect(report.uniqueAssetCount).toBe(2);
  });

  it("detects consecutive asset reuse", async () => {
    const manifest = fixture(["a", "a", "b", "c"]);

    const images = [
      await pattern(1),
      await pattern(1),
      await pattern(2),
      await pattern(3),
    ];

    const report = await analyze(manifest, images);

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "CONSECUTIVE_ASSET_REUSE",
      ),
    ).toBe(true);
  });

  it("detects near-identical visuals from different assets", async () => {
    const manifest = fixture(["a", "b", "c", "d"]);

    const same = await pattern(1);

    const report = await analyze(
      manifest,
      [same, same, same, same],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code ===
          "CONSECUTIVE_VISUAL_SIMILARITY",
      ),
    ).toBe(true);

    expect(report.visualGroupCount).toBe(1);
  });

  it("detects low visual variety", async () => {
    const manifest = fixture();

    const image = await pattern(1);

    const report = await analyze(
      manifest,
      [image, image, image, image],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "LOW_VISUAL_VARIETY",
      ),
    ).toBe(true);
  });

  it("does not flag exact reuse for distinct assets", async () => {
    const manifest = fixture();

    const images = await Promise.all(
      [1, 2, 3, 4].map(pattern),
    );

    const report = await analyze(
      manifest,
      images,
    );

    expect(report.uniqueAssetCount).toBe(4);

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "EXACT_ASSET_REUSE",
      ),
    ).toBe(false);
  });

  it("rejects invalid similarity policy", async () => {
    const manifest = fixture();
    const plan = createVideoQaFramePlan(manifest);
    const white = await pattern(1);

    await expect(
      analyzeVideoVisualVariety(
        manifest,
        plan,
        plan.samples.map((sample) => ({
          frame: sample.frame,
          png: white,
        })),
        { nearDuplicateDistance: 65 },
      ),
    ).rejects.toThrow(
      "M8 invalid visual variety policy",
    );
  });

  it("rejects missing decoded samples", async () => {
    const manifest = fixture();
    const plan = createVideoQaFramePlan(manifest);

    await expect(
      analyzeVideoVisualVariety(
        manifest,
        plan,
        [],
      ),
    ).rejects.toThrow(
      "M8 visual variety frame coverage mismatch",
    );
  });

  it("binds report to composition and frame plan", async () => {
    const manifest = fixture();
    const images = await Promise.all(
      [1, 2, 3, 4].map(pattern),
    );

    const report = await analyze(
      manifest,
      images,
    );

    expect(report.compositionHash).toBe(
      manifest.compositionHash,
    );

    expect(report.reportHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    expect(report.shotCount).toBe(4);
  });
});
