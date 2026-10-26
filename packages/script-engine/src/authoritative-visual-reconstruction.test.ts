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
  reconstructAuthoritativeVisualPackage,
  type AuthoritativeVisualInputs,
} from "./authoritative-visual-reconstruction.js";

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function fileHash(value: Buffer): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

describe("Authoritative visual reconstruction", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = undefined;
    }
  });

  async function fixture(): Promise<AuthoritativeVisualInputs> {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m5-authority-",
      ),
    );

    const bytes = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#546a81",
      },
    })
      .png()
      .toBuffer();

    const filename = path.join(
      root,
      "fixture.png",
    );

    await writeFile(filename, bytes);

    const asset: MediaAsset = {
      version: 1,
      id: "asset-001",
      kind: "image",
      localPath: filename,
      sha256: fileHash(bytes),
      bytes: bytes.length,
      mimeType: "image/png",
      width: 1280,
      height: 720,

      provenance: {
        source: "local_library",
        providerAssetId: "owned-fixture",
        license: {
          status: "unknown",
        },
      },

      createdAt: "2026-10-13T10:00:00.000Z",
    };

    const assignment: AssignedMedia = {
      version: 1,
      shotId: "shot-001",
      mode: "B",
      assignmentSource: "local_library",
      assignedAt: "2026-10-13T10:00:00.000Z",
      asset,
    };

    const report: MediaResolutionReport = {
      version: 1,
      jobId: "job-m5-authority",
      mode: "B",
      expectedShots: 1,
      assignedShots: 1,
      outcomes: [
        {
          status: "assigned",
          assignment,
        },
      ],
      assignments: [assignment],
      issues: [],
      passed: true,
    };

    return {
      request: {
        jobId: "job-m5-authority",
        mode: "B",
        shotIds: ["shot-001"],
      },

      report,

      productionPackageHash: "a".repeat(64),
      mediaManifestHash: "b".repeat(64),

      timings: [
        {
          shotId: "shot-001",
          startSeconds: 0,
          endSeconds: 4,
        },
      ],

      fps: 30,
    };
  }

  it("reconstructs a complete canonical visual package", async () => {
    const input = await fixture();

    const result =
      await reconstructAuthoritativeVisualPackage(
        input,
      );

    expect(result.bindings.shotCount).toBe(1);
    expect(result.geometry.totalFrames).toBe(120);
    expect(result.visual.shotCount).toBe(1);

    expect(
      result.visual.shots[0]?.assetSha256,
    ).toBe(
      result.bindings.bindings[0]?.asset.sha256,
    );
  });

  it("accepts identical persisted planning packages", async () => {
    const input = await fixture();

    const original =
      await reconstructAuthoritativeVisualPackage(
        input,
      );

    const reconstructed =
      await reconstructAuthoritativeVisualPackage(
        input,
        original,
      );

    expect(reconstructed).toEqual(original);
  });

  it("rejects a rehashed but noncanonical motion plan", async () => {
    const input = await fixture();

    const original =
      await reconstructAuthoritativeVisualPackage(
        input,
      );

    const tampered = structuredClone(
      original.motion,
    );

    const shot = tampered.shots[0]!;

    // A schema-valid camera edit.
    shot.startScale = 1.12;

    // Attacker recalculates the aggregate hash.
    const {
      motionPackageHash: _oldHash,
      ...payload
    } = tampered;

    tampered.motionPackageHash = hash(payload);

    await expect(
      reconstructAuthoritativeVisualPackage(
        input,
        {
          motion: tampered,
        },
      ),
    ).rejects.toThrow(
      "Noncanonical visual package: motion",
    );
  });

  it("rejects a rehashed but noncanonical crop", async () => {
    const input = await fixture();

    const original =
      await reconstructAuthoritativeVisualPackage(
        input,
      );

    const tampered = structuredClone(
      original.geometry,
    );

    const crop = tampered.shots[0]?.startCrop;

    if (!crop) {
      throw new Error(
        "Acceptance fixture must use cover crop",
      );
    }

    crop.left += 1;

    const {
      geometryPackageHash: _oldHash,
      ...payload
    } = tampered;

    tampered.geometryPackageHash = hash(payload);

    await expect(
      reconstructAuthoritativeVisualPackage(
        input,
        {
          geometry: tampered,
        },
      ),
    ).rejects.toThrow(
      "Noncanonical visual package: geometry",
    );
  });

  it("rejects changed image bytes during reconstruction", async () => {
    const input = await fixture();

    const asset =
      input.report.assignments[0]!.asset;

    await writeFile(
      asset.localPath,
      Buffer.from("corrupted image"),
    );

    await expect(
      reconstructAuthoritativeVisualPackage(
        input,
      ),
    ).rejects.toThrow(
      "Image is not renderer-ready",
    );
  });
});
