import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
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
  RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import {
  PersistentVisualPackageStore,
  getPersistedVisualPath,
} from "./persistent-visual-package.js";

const JOB_ID = "job-m5-persistence";

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function visualFixture(): RendererReadyVisualPackage {
  const shot = {
    version: 1 as const,

    shotId: "shot-001",
    shotIndex: 0,

    bindingHash: "a".repeat(64),
    assetSha256: "b".repeat(64),

    assetId: "asset-001",
    assetPath: "/objects/test.png",

    sourceWidth: 1280,
    sourceHeight: 720,

    startFrame: 0,
    endFrameExclusive: 120,
    durationFrames: 120,

    fit: "contain" as const,
    motion: "static" as const,

    startCrop: null,
    endCrop: null,
  };

  const payload = {
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

    totalFrames: 120,
    shotCount: 1,

    shots: [shot],
  };

  return {
    ...payload,
    visualPackageHash: hash(payload),
  };
}

describe("Persistent visual package", () => {
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
        "youcreator-m5-persistent-",
      ),
    );

    const original = visualFixture();

    const preparation = {
      prepare: vi.fn(async () => ({
        visual: original,
      })),
    };

    const options = {
      jobDirectory: (jobId: string) =>
        path.join(root!, "jobs", jobId),

      preparation,
    };

    return {
      original,
      preparation,
      options,
      store: new PersistentVisualPackageStore(
        options,
      ),
    };
  }

  it("atomically persists a verified visual package", async () => {
    const { store } = await fixture();

    const result = await store.run(JOB_ID);

    expect(result.reused).toBe(false);
    expect(result.record.jobId).toBe(JOB_ID);

    const saved = JSON.parse(
      await readFile(
        result.artifactPath,
        "utf8",
      ),
    );

    expect(saved).toEqual(result.record);

    expect(
      path.basename(result.artifactPath),
    ).toBe("renderer-ready.json");
  });

  it("reuses a verified package without changing its content", async () => {
    const { store, preparation } =
      await fixture();

    const first = await store.run(JOB_ID);
    const second = await store.run(JOB_ID);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);

    expect(second.record).toEqual(
      first.record,
    );

    expect(
      await store.validate(
        JOB_ID,
        first.record.packageHash,
      ),
    ).toBe(true);

    expect(preparation.prepare).toHaveBeenCalledTimes(
      3,
    );
  });

  it("rejects tampered persisted JSON", async () => {
    const { store } = await fixture();

    const first = await store.run(JOB_ID);

    const saved = JSON.parse(
      await readFile(
        first.artifactPath,
        "utf8",
      ),
    );

    saved.visual.totalFrames = 999;

    await writeFile(
      first.artifactPath,
      JSON.stringify(saved),
    );

    await expect(
      store.run(JOB_ID),
    ).rejects.toThrow(
      "Persistent visual record integrity mismatch",
    );

    expect(
      await store.validate(
        JOB_ID,
        first.record.packageHash,
      ),
    ).toBe(false);
  });

  it("rejects a newly reconstructed noncanonical result", async () => {
    const test = await fixture();

    const first = await test.store.run(
      JOB_ID,
    );

    const modified = visualFixture();

    modified.shots[0]!.durationFrames = 119;

    const {
      visualPackageHash: _previous,
      ...payload
    } = modified;

    modified.visualPackageHash =
      hash(payload);

    test.preparation.prepare.mockResolvedValue({
      visual: modified,
    });

    await expect(
      test.store.run(JOB_ID),
    ).rejects.toThrow(
      "Persisted visual is no longer canonical",
    );

    expect(
      await test.store.validate(
        JOB_ID,
        first.record.packageHash,
      ),
    ).toBe(false);
  });

  it("fails closed when upstream verification fails", async () => {
    const test = await fixture();

    const first = await test.store.run(
      JOB_ID,
    );

    test.preparation.prepare.mockRejectedValue(
      new Error("Stored media rights not approved"),
    );

    await expect(
      test.store.run(JOB_ID),
    ).rejects.toThrow(
      "Stored media rights not approved",
    );

    expect(
      await test.store.validate(
        JOB_ID,
        first.record.packageHash,
      ),
    ).toBe(false);
  });

  it("allows concurrent identical publication without overwriting", async () => {
    const test = await fixture();

    const another =
      new PersistentVisualPackageStore(
        test.options,
      );

    const [first, second] = await Promise.all([
      test.store.run(JOB_ID),
      another.run(JOB_ID),
    ]);

    expect(first.record.recordHash).toBe(
      second.record.recordHash,
    );

    const savedPath =
      getPersistedVisualPath(
        test.options.jobDirectory(JOB_ID),
        JOB_ID,
      );

    const saved = JSON.parse(
      await readFile(
        savedPath,
        "utf8",
      ),
    );

    expect(saved.recordHash).toBe(
      first.record.recordHash,
    );
  });
});
