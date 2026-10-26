import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import type {
  MediaAsset,
} from "@youcreator/contracts";

import type {
  AssignedMedia,
} from "./assigned-media.js";

import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  createShotMediaBindings,
} from "./shot-media-binding.js";

import {
  createShotMotionPlan,
  type ShotMotionPackage,
} from "./shot-motion-plan.js";

import {
  createShotFrameGeometry,
  createShotFrameGeometryFromFrames,
} from "./shot-frame-geometry.js";

import {
  createRendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import type {
  AudioAlignedFramePlan,
} from "./audio-aligned-frame-plan.js";

import {
  reconstructAudioAlignedVisual,
  verifyAudioAlignedVisual,
} from "./audio-aligned-visual-reconstruction.js";

function sha256Buffer(value: Buffer): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function motionFixture(
  fit: "cover" | "contain" = "cover",
): ShotMotionPackage {
  const payload = {
    version: 1 as const,
    jobId: "job-m6-exact-geometry",

    bindingPackageHash: "a".repeat(64),

    frameWidth: 1920,
    frameHeight: 1080,

    shots: [
      {
        version: 1 as const,

        shotId: "shot-001",
        shotIndex: 0,

        assetSha256: "b".repeat(64),
        bindingHash: "c".repeat(64),

        durationSeconds: 2,

        frameWidth: 1920,
        frameHeight: 1080,

        sourceWidth: 1280,
        sourceHeight: 720,

        fit,

        motion:
          fit === "cover"
            ? "zoom_in" as const
            : "static" as const,

        startScale: 1.03,
        endScale: 1.09,

        startX: 0.5,
        startY: 0.5,
        endX: 0.5,
        endY: 0.5,
      },
      {
        version: 1 as const,

        shotId: "shot-002",
        shotIndex: 1,

        assetSha256: "d".repeat(64),
        bindingHash: "e".repeat(64),

        durationSeconds: 2,

        frameWidth: 1920,
        frameHeight: 1080,

        sourceWidth: 1280,
        sourceHeight: 720,

        fit,

        motion:
          fit === "cover"
            ? "zoom_out" as const
            : "static" as const,

        startScale: 1.09,
        endScale: 1.03,

        startX: 0.5,
        startY: 0.5,
        endX: 0.5,
        endY: 0.5,
      },
    ],
  };

  return {
    ...payload,
    motionPackageHash: hash(payload),
  };
}

function frameInput(
  fit: "cover" | "contain" = "cover",
) {
  return {
    motionPlan: motionFixture(fit),

    frameTimings: [
      {
        shotId: "shot-001",
        shotIndex: 0,
        startFrame: 0,
        endFrameExclusive: 34,
        durationFrames: 34,
      },
      {
        shotId: "shot-002",
        shotIndex: 1,
        startFrame: 34,
        endFrameExclusive: 90,
        durationFrames: 56,
      },
    ],

    fps: 30,
    totalFrames: 90,
  };
}

describe("M6 exact audio-aligned geometry", () => {
  it("uses exact M6 frames instead of old motion durations", () => {
    const result =
      createShotFrameGeometryFromFrames(
        frameInput(),
      );

    expect(result.totalFrames).toBe(90);

    expect(result.shots[0]).toMatchObject({
      startFrame: 0,
      endFrameExclusive: 34,
      durationFrames: 34,
    });

    expect(result.shots[1]).toMatchObject({
      startFrame: 34,
      endFrameExclusive: 90,
      durationFrames: 56,
    });
  });

  it("preserves original asset and binding identities", () => {
    const input = frameInput();

    const result =
      createShotFrameGeometryFromFrames(
        input,
      );

    for (
      let index = 0;
      index < result.shots.length;
      index++
    ) {
      expect(result.shots[index]).toMatchObject({
        assetSha256:
          input.motionPlan.shots[index]!.assetSha256,

        bindingHash:
          input.motionPlan.shots[index]!.bindingHash,
      });
    }
  });

  it("reuses M5 safe crop calculations", () => {
    const result =
      createShotFrameGeometryFromFrames(
        frameInput("cover"),
      );

    for (const shot of result.shots) {
      expect(shot.startCrop).not.toBeNull();
      expect(shot.endCrop).not.toBeNull();

      for (
        const crop of [
          shot.startCrop!,
          shot.endCrop!,
        ]
      ) {
        expect(crop.left).toBeGreaterThanOrEqual(0);
        expect(crop.top).toBeGreaterThanOrEqual(0);

        expect(
          crop.left + crop.width,
        ).toBeLessThanOrEqual(
          shot.sourceWidth + 0.00001,
        );

        expect(
          crop.top + crop.height,
        ).toBeLessThanOrEqual(
          shot.sourceHeight + 0.00001,
        );
      }
    }
  });

  it("does not create crop rectangles for contain fit", () => {
    const result =
      createShotFrameGeometryFromFrames(
        frameInput("contain"),
      );

    for (const shot of result.shots) {
      expect(shot.startCrop).toBeNull();
      expect(shot.endCrop).toBeNull();
    }
  });

  it("rejects gaps or overlapping frame ranges", () => {
    const input = frameInput();

    input.frameTimings[1]!.startFrame = 35;
    input.frameTimings[1]!.durationFrames = 55;

    expect(() =>
      createShotFrameGeometryFromFrames(
        input,
      ),
    ).toThrow(
      "Exact geometry frame continuity mismatch",
    );
  });

  it("rejects invalid shot identity ordering", () => {
    const input = frameInput();

    input.frameTimings[1]!.shotId =
      "wrong-shot";

    expect(() =>
      createShotFrameGeometryFromFrames(
        input,
      ),
    ).toThrow(
      "Exact geometry shot mismatch",
    );
  });

  it("rejects incomplete total-frame coverage", () => {
    const input = frameInput();

    input.totalFrames = 91;

    expect(() =>
      createShotFrameGeometryFromFrames(
        input,
      ),
    ).toThrow(
      "Exact geometry total frame mismatch",
    );
  });

  it("produces deterministic geometry hashes", () => {
    const input = frameInput();

    expect(
      createShotFrameGeometryFromFrames(
        input,
      ),
    ).toEqual(
      createShotFrameGeometryFromFrames(
        input,
      ),
    );
  });
});

describe("M6 audio-aligned visual reconstruction integration", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, {
        force: true,
        recursive: true,
      });
      root = undefined;
    }
  });

  async function integrationFixture() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-m6-recon-"),
    );

    const assignments: AssignedMedia[] = [];

    for (let index = 0; index < 2; index++) {
      const shotId = `shot-00${index + 1}`;

      const bytes = await sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 3,
          background:
            index === 0 ? "#586b89" : "#89806a",
        },
      }).png().toBuffer();

      const filename = path.join(
        root,
        `${shotId}.png`,
      );

      await writeFile(filename, bytes);

      const asset: MediaAsset = {
        version: 1,
        id: `asset-${index}`,
        kind: "image",
        localPath: filename,
        sha256: sha256Buffer(bytes),
        bytes: bytes.length,
        mimeType: "image/png",
        width: 1280,
        height: 720,
        provenance: {
          source: "local_library",
          providerAssetId: `fixture-${index}`,
          license: {
            status: "unknown",
          },
        },
        createdAt: "2026-10-13T10:00:00.000Z",
      };

      assignments.push({
        version: 1,
        shotId,
        mode: "B",
        assignmentSource: "local_library",
        assignedAt: "2026-10-13T10:00:00.000Z",
        asset,
      });
    }

    const report: MediaResolutionReport = {
      version: 1,
      jobId: "job-m6-recon",
      mode: "B",
      expectedShots: 2,
      assignedShots: 2,
      outcomes: assignments.map((assignment) => ({
        status: "assigned" as const,
        assignment,
      })),
      assignments,
      issues: [],
      passed: true,
    };

    const productionPackageHash = "a".repeat(64);
    const mediaManifestHash = "b".repeat(64);

    const bindings = createShotMediaBindings({
      request: {
        jobId: "job-m6-recon",
        mode: "B",
        shotIds: ["shot-001", "shot-002"],
      },
      report,
      productionPackageHash,
      mediaManifestHash,
    });

    const motion = createShotMotionPlan({
      bindings,
      durations: [
        { shotId: "shot-001", durationSeconds: 3 },
        { shotId: "shot-002", durationSeconds: 4 },
      ],
    });

    const geometry = createShotFrameGeometry({
      motionPlan: motion,
      timings: [
        {
          shotId: "shot-001",
          startSeconds: 0,
          endSeconds: 3,
        },
        {
          shotId: "shot-002",
          startSeconds: 3,
          endSeconds: 7,
        },
      ],
      fps: 30,
    });

    const m5Visual = await createRendererReadyVisualPackage({
      bindings,
      motion,
      geometry,
    });

    const framePlanPayload = {
      version: 1 as const,
      jobId: "job-m6-recon",

      productionPackageHash,
      scriptHash: "5".repeat(64),
      audioSha256: "c".repeat(64),
      alignmentHash: "6".repeat(64),
      anchorPackageHash: "7".repeat(64),
      sampleTimelineHash: "8".repeat(64),

      sampleRate: 24000,
      totalSamples: 72000,

      fps: 30,
      totalFrames: 90,
      shotCount: 2,

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

    const framePlan: AudioAlignedFramePlan = {
      ...framePlanPayload,
      framePlanHash: hash(framePlanPayload),
    };

    return {
      bindings,
      m5Visual,
      framePlan,
    };
  }

  it("replaces estimated M5 timing with actual M6 frame timing", async () => {
    const input = await integrationFixture();

    const result =
      await reconstructAudioAlignedVisual(input);

    expect(result.visual.totalFrames).toBe(90);
    expect(input.m5Visual.totalFrames).toBe(210);

    expect(result.visual.shots[0]).toMatchObject({
      shotId: "shot-001",
      startFrame: 0,
      endFrameExclusive: 34,
      durationFrames: 34,
    });

    expect(result.visual.shots[1]).toMatchObject({
      shotId: "shot-002",
      startFrame: 34,
      endFrameExclusive: 90,
      durationFrames: 56,
    });
  });

  it("preserves identical source paths, asset IDs, and asset hashes", async () => {
    const input = await integrationFixture();

    const result =
      await reconstructAudioAlignedVisual(input);

    for (let index = 0; index < result.visual.shots.length; index++) {
      const shot = result.visual.shots[index]!;
      const original = input.m5Visual.shots[index]!;

      expect(shot.assetId).toBe(original.assetId);
      expect(shot.assetSha256).toBe(original.assetSha256);
      expect(shot.assetPath).toBe(original.assetPath);
      expect(shot.bindingHash).toBe(original.bindingHash);
      expect(shot.sourceWidth).toBe(original.sourceWidth);
      expect(shot.sourceHeight).toBe(original.sourceHeight);
    }
  });

  it("produces deterministic hashes and passes verifyAudioAlignedVisual", async () => {
    const input = await integrationFixture();

    const first =
      await reconstructAudioAlignedVisual(input);

    const second =
      await reconstructAudioAlignedVisual(input);

    expect(second).toEqual(first);
    expect(second.audioAlignedVisualHash).toBe(
      first.audioAlignedVisualHash,
    );

    const verified =
      await verifyAudioAlignedVisual(first, input);

    expect(verified).toEqual(first);
  });

  it("rejects tampered persisted candidate in verifyAudioAlignedVisual", async () => {
    const input = await integrationFixture();

    const result =
      await reconstructAudioAlignedVisual(input);

    const tampered = structuredClone(result);
    tampered.visual.shots[0]!.durationFrames += 1;

    await expect(
      verifyAudioAlignedVisual(tampered, input),
    ).rejects.toThrow(
      "M6 audio-aligned visual reconstruction mismatch",
    );
  });

  it("rejects tampered audio frame plan", async () => {
    const input = await integrationFixture();

    input.framePlan.shots[0]!.durationFrames = 99;

    await expect(
      reconstructAudioAlignedVisual(input),
    ).rejects.toThrow();
  });

  it("rejects corrupted image bytes failing readiness verification", async () => {
    const input = await integrationFixture();

    const filename =
      input.bindings.bindings[0]!.asset.localPath;

    await writeFile(
      filename,
      Buffer.from("not a real png image"),
    );

    await expect(
      reconstructAudioAlignedVisual(input),
    ).rejects.toThrow(
      "Image is not renderer-ready",
    );
  });
});
