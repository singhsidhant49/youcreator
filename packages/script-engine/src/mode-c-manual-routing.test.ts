import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  MediaResolutionCoordinator,
  type ShotMediaResolver,
} from "./media-resolution-coordinator.js";
import { ManualSharedMediaService } from "./manual-shared-media.js";
import { MediaAcquirer } from "./media-acquirer.js";
import { MediaObjectStore } from "./media-object-store.js";

async function createPngFixture(filepath: string, extra = ""): Promise<string> {
  const png1x1 = Buffer.concat([
    Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    ),
    Buffer.from(extra, "utf8"),
  ]);
  await writeFile(filepath, png1x1);
  return filepath;
}

describe("New Mode C — Manual Visuals Routing & Strict Isolation", () => {
  it("resolves user-provided manual assets with canonical Mode C contracts and strict isolation from stock and AI providers", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-c-test-"));
    try {
      const storageDir = path.join(tmp, "storage");
      const userUploadDir = path.join(tmp, "user_uploads");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(storageDir, { recursive: true });
      await mkdir(userUploadDir, { recursive: true });

      const img1 = path.join(userUploadDir, "manual1.png");
      const img2 = path.join(userUploadDir, "manual2.png");
      await createPngFixture(img1, "file1");
      await createPngFixture(img2, "file2");

      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [userUploadDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });
      const manualShared = new ManualSharedMediaService({ acquirer, objectStore });

      const stockResolveFn = vi.fn();
      const aiResolveFn = vi.fn();

      const coordinator = new MediaResolutionCoordinator({
        manualShared,
        stockResolver: { resolve: stockResolveFn },
        aiResolver: { resolve: aiResolveFn },
        assetVerifier: { verify: async () => true },
        rightsChecker: { check: async () => "approved" },
      });

      const report = await coordinator.run({
        version: 2,
        jobId: "job-manual-mode-c",
        mode: "C",
        shotIds: ["shot-c-1", "shot-c-2"],
        assignments: [
          {
            shotId: "shot-c-1",
            assetId: "custom-chart-infographic",
            localPath: img1,
          },
          {
            shotId: "shot-c-2",
            assetId: "custom-founder-photo",
            localPath: img2,
          },
        ],
      });

      expect(report.passed).toBe(true);
      expect(report.mode).toBe("C");
      expect(report.expectedShots).toBe(2);
      expect(report.assignedShots).toBe(2);

      // Verify canonical contracts
      expect(report.assignments[0]?.shotId).toBe("shot-c-1");
      expect(report.assignments[0]?.mode).toBe("C");
      expect(report.assignments[0]?.assignmentSource).toBe("manual_upload");
      expect(report.assignments[0]?.asset.provenance.providerAssetId).toBe("custom-chart-infographic");

      expect(report.assignments[1]?.shotId).toBe("shot-c-2");
      expect(report.assignments[1]?.mode).toBe("C");
      expect(report.assignments[1]?.assignmentSource).toBe("manual_upload");
      expect(report.assignments[1]?.asset.provenance.providerAssetId).toBe("custom-founder-photo");

      // STRICT ISOLATION: Zero calls to stock or AI resolvers
      expect(stockResolveFn).not.toHaveBeenCalled();
      expect(aiResolveFn).not.toHaveBeenCalled();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects jobs when required shot assignments are missing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-c-missing-"));
    try {
      const storageDir = path.join(tmp, "storage");
      const userUploadDir = path.join(tmp, "user_uploads");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(storageDir, { recursive: true });
      await mkdir(userUploadDir, { recursive: true });

      const img1 = path.join(userUploadDir, "manual1.png");
      await createPngFixture(img1, "file1");

      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [userUploadDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });
      const manualShared = new ManualSharedMediaService({ acquirer, objectStore });

      const coordinator = new MediaResolutionCoordinator({
        manualShared,
        assetVerifier: { verify: async () => true },
        rightsChecker: { check: async () => "approved" },
      });

      // Request expects 2 shots, but assignments only cover shot-1
      const report = await coordinator.run({
        version: 2,
        jobId: "job-manual-missing",
        mode: "C",
        shotIds: ["shot-c-1", "shot-c-missing-2"],
        assignments: [
          {
            shotId: "shot-c-1",
            assetId: "asset-1",
            localPath: img1,
          },
        ],
      });

      expect(report.passed).toBe(false);
      expect(report.issues.some((i) => i.code === "MISSING_SHOT" && i.shotId === "shot-c-missing-2")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects invalid manual media paths with structured INVALID_ASSET failures and maintains isolation", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-c-invalid-"));
    try {
      const storageDir = path.join(tmp, "storage");
      const userUploadDir = path.join(tmp, "user_uploads");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(storageDir, { recursive: true });
      await mkdir(userUploadDir, { recursive: true });

      const nonExistentPath = path.join(userUploadDir, "does_not_exist.png");

      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [userUploadDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });
      const manualShared = new ManualSharedMediaService({ acquirer, objectStore });

      const stockResolveFn = vi.fn();
      const aiResolveFn = vi.fn();

      const coordinator = new MediaResolutionCoordinator({
        manualShared,
        stockResolver: { resolve: stockResolveFn },
        aiResolver: { resolve: aiResolveFn },
        assetVerifier: { verify: async () => true },
        rightsChecker: { check: async () => "approved" },
      });

      const report = await coordinator.run({
        version: 2,
        jobId: "job-manual-invalid",
        mode: "C",
        shotIds: ["shot-invalid-1"],
        assignments: [
          {
            shotId: "shot-invalid-1",
            assetId: "missing-asset",
            localPath: nonExistentPath,
          },
        ],
      });

      expect(report.passed).toBe(false);
      expect(report.issues.some((i) => i.code === "RESOLUTION_FAILED")).toBe(true);

      // Even on manual file failures, must NEVER fall back to stock or AI providers
      expect(stockResolveFn).not.toHaveBeenCalled();
      expect(aiResolveFn).not.toHaveBeenCalled();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
