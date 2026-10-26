import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  PipelineContext,
} from "@youcreator/core";

import type {
  RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import {
  PersistentVisualPackageStore,
} from "./persistent-visual-package.js";

import {
  createVisualPipelineStage,
} from "./visual-pipeline-stage.js";

const JOB_ID = "job-m5-visual-stage";

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function visualFixture(): RendererReadyVisualPackage {
  const payload = {
    version: 1 as const,
    jobId: JOB_ID,

    productionPackageHash: "a".repeat(64),
    mediaManifestHash: "b".repeat(64),
    bindingPackageHash: "c".repeat(64),
    motionPackageHash: "d".repeat(64),
    geometryPackageHash: "e".repeat(64),

    fps: 30,
    frameWidth: 1920,
    frameHeight: 1080,
    totalFrames: 120,
    shotCount: 1,

    shots: [{
      version: 1 as const,
      shotId: "shot-001",
      shotIndex: 0,

      bindingHash: "f".repeat(64),
      assetSha256: "1".repeat(64),

      assetId: "asset-001",
      assetPath: "/objects/fixture.png",

      sourceWidth: 1920,
      sourceHeight: 1080,

      startFrame: 0,
      endFrameExclusive: 120,
      durationFrames: 120,

      fit: "contain" as const,
      motion: "static" as const,

      startCrop: null,
      endCrop: null,
    }],
  };

  return {
    ...payload,
    visualPackageHash: hash(payload),
  };
}

describe("Native visual pipeline stage", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();

    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = undefined;
    }
  });

  async function fixture() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m5-visual-stage-",
      ),
    );

    const jobDirectory = path.join(
      root,
      JOB_ID,
    );

    const visual = visualFixture();

    const prepare = vi.fn(
      async () => ({ visual }),
    );

    const store =
      new PersistentVisualPackageStore({
        jobDirectory: () => jobDirectory,

        preparation: {
          prepare,
        },
      });

    const stage = createVisualPipelineStage({
      store,
      jobDirectory: () => jobDirectory,
    });

    const context = {
      job: { id: JOB_ID },

      jobDirectory,

      outputs: new Map([
        ["media", { completed: true }],
      ]),
    } as unknown as PipelineContext;

    return {
      stage,
      store,
      prepare,
      context,
    };
  }

  it("declares the native media dependency", async () => {
    const test = await fixture();

    expect(test.stage.id).toBe("visual");
    expect(test.stage.dependencies).toEqual([
      "media",
    ]);

    expect(test.stage.version).toBe(
      "m5-visual-pipeline-v1",
    );
  });

  it("persists a package and validates its checkpoint", async () => {
    const test = await fixture();

    const output = await test.stage.execute(
      test.context,
    );

    expect(output.shotCount).toBe(1);
    expect(output.totalFrames).toBe(120);

    expect(
      await test.stage.validateOutput?.(
        output,
        test.context,
      ),
    ).toBe(true);
  });

  it("reuses an existing visual artifact without replacing it", async () => {
    const test = await fixture();

    const first = await test.stage.execute(
      test.context,
    );

    const second = await test.stage.execute(
      test.context,
    );

    expect(second).toEqual(first);

    expect(
      test.prepare,
    ).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the media dependency is absent", async () => {
    const test = await fixture();

    const invalidContext = {
      ...test.context,
      outputs: new Map(),
    } as unknown as PipelineContext;

    await expect(
      test.stage.execute(
        invalidContext,
      ),
    ).rejects.toThrow(
      "requires completed media output",
    );
  });

  it("rejects checkpoint reuse when upstream verification fails", async () => {
    const test = await fixture();

    const output = await test.stage.execute(
      test.context,
    );

    test.prepare.mockRejectedValue(
      new Error(
        "Stored media rights not approved",
      ),
    );

    expect(
      await test.stage.validateOutput?.(
        output,
        test.context,
      ),
    ).toBe(false);

    await expect(
      test.stage.execute(
        test.context,
      ),
    ).rejects.toThrow(
      "Stored media rights not approved",
    );
  });
});
