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
} from "./shot-motion-plan.js";

import {
  createShotFrameGeometry,
} from "./shot-frame-geometry.js";

import {
  createRendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

function sha256(value: Buffer): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

describe("Renderer-ready visual package", () => {
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

  async function fixture() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-m5-render-"),
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
        sha256: sha256(bytes),
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
      jobId: "job-m5-render",
      mode: "B",
      expectedShots: 2,
      assignedShots: 2,
      outcomes: assignments.map(
        (assignment) => ({
          status: "assigned" as const,
          assignment,
        }),
      ),
      assignments,
      issues: [],
      passed: true,
    };

    const bindings = createShotMediaBindings({
      request: {
        jobId: "job-m5-render",
        mode: "B",
        shotIds: ["shot-001", "shot-002"],
      },
      report,
      productionPackageHash: "a".repeat(64),
      mediaManifestHash: "b".repeat(64),
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

    return { bindings, motion, geometry };
  }

  it("produces a complete renderer-ready package", async () => {
    const input = await fixture();

    const result =
      await createRendererReadyVisualPackage(input);

    expect(result.shotCount).toBe(2);
    expect(result.totalFrames).toBe(210);

    expect(
      result.shots.map((shot) => shot.shotId),
    ).toEqual(["shot-001", "shot-002"]);

    expect(
      result.shots.map((shot) => [
        shot.startFrame,
        shot.endFrameExclusive,
      ]),
    ).toEqual([
      [0, 90],
      [90, 210],
    ]);
  });

  it("produces deterministic output", async () => {
    const input = await fixture();

    const first =
      await createRendererReadyVisualPackage(input);

    const second =
      await createRendererReadyVisualPackage(input);

    expect(second).toEqual(first);
  });

  it("rejects corrupted source image bytes", async () => {
    const input = await fixture();

    const filename =
      input.bindings.bindings[0]!.asset.localPath;

    await writeFile(
      filename,
      Buffer.from("not a real image"),
    );

    await expect(
      createRendererReadyVisualPackage(input),
    ).rejects.toThrow(
      "Image is not renderer-ready",
    );
  });

  it("rejects tampered geometry package integrity", async () => {
    const input = await fixture();

    input.geometry.shots[0]!.startFrame = 3;

    await expect(
      createRendererReadyVisualPackage(input),
    ).rejects.toThrow(
      "Package integrity mismatch",
    );
  });

  it("rejects cross-package shot identity mismatch", async () => {
    const input = await fixture();

    // Rehash the changed geometry to prove that
    // valid outer hashes alone are not enough.
    input.geometry.shots[0]!.shotId =
      "incorrect-shot";

    const {
      geometryPackageHash: _previous,
      ...payload
    } = input.geometry;

    input.geometry.geometryPackageHash =
      hash(payload);

    await expect(
      createRendererReadyVisualPackage(input),
    ).rejects.toThrow(
      "Visual shot identity mismatch",
    );
  });
});
