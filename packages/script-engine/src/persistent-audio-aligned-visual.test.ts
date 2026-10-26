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
  AudioAlignedVisualPackage,
} from "./audio-aligned-visual-reconstruction.js";

import {
  PersistentAudioAlignedVisualStore,
  getPersistedAudioAlignedVisualPath,
  type AudioAlignedVisualReconstructionPort,
} from "./persistent-audio-aligned-visual.js";

const JOB_ID = "job-m6-persisted-visual";

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function packageFixture(): AudioAlignedVisualPackage {
  const visualPayload = {
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
    totalFrames: 90,
    shotCount: 1,

    shots: [{
      version: 1 as const,
      shotId: "shot-001",
      shotIndex: 0,

      bindingHash: "f".repeat(64),
      assetSha256: "1".repeat(64),

      assetId: "asset-001",
      assetPath: "/objects/asset-001.png",

      sourceWidth: 1920,
      sourceHeight: 1080,

      startFrame: 0,
      endFrameExclusive: 90,
      durationFrames: 90,

      fit: "contain" as const,
      motion: "static" as const,

      startCrop: null,
      endCrop: null,
    }],
  };

  const visual = {
    ...visualPayload,
    visualPackageHash: hash(visualPayload),
  };

  const payload = {
    version: 1 as const,
    jobId: JOB_ID,

    contractHash: "2".repeat(64),
    m5VisualPackageHash: "3".repeat(64),
    framePlanHash: "4".repeat(64),

    audioSha256: "5".repeat(64),
    scriptHash: "6".repeat(64),
    alignmentHash: "7".repeat(64),

    motionPackageHash: visual.motionPackageHash,
    geometryPackageHash: visual.geometryPackageHash,

    visual,
  };

  return {
    ...payload,
    audioAlignedVisualHash: hash(payload),
  };
}

describe("M6 persistent audio-aligned visual", () => {
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
        "youcreator-m6-aligned-store-",
      ),
    );

    const canonical = packageFixture();

    const reconstruct = vi.fn(
      async (_jobId: string) => canonical,
    );

    const reconstruction: AudioAlignedVisualReconstructionPort = {
      reconstruct,
    };

    const jobDirectory = (jobId: string) =>
      path.join(root!, "jobs", jobId);

    const options = {
      jobDirectory,
      reconstruction,
    };

    return {
      canonical,
      reconstruct,
      options,
      store: new PersistentAudioAlignedVisualStore(
        options,
      ),
    };
  }

  it("publishes the canonical package and checkpoint", async () => {
    const test = await fixture();

    const saved = await test.store.run(JOB_ID);

    expect(saved.reused).toBe(false);
    expect(saved.checkpoint.totalFrames).toBe(90);
    expect(saved.checkpoint.shotCount).toBe(1);

    expect(saved.checkpoint.audioSha256).toBe(
      test.canonical.audioSha256,
    );

    const contents = JSON.parse(
      await readFile(saved.artifactPath, "utf8"),
    );

    expect(contents).toEqual(saved.record);

    expect(
      saved.artifactPath,
    ).toBe(
      getPersistedAudioAlignedVisualPath(
        test.options.jobDirectory(JOB_ID),
        JOB_ID,
      ),
    );
  });

  it("reuses an identical canonical artifact", async () => {
    const test = await fixture();

    const first = await test.store.run(JOB_ID);
    const second = await test.store.run(JOB_ID);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);

    expect(second.record).toEqual(first.record);
    expect(second.checkpoint).toEqual(first.checkpoint);

    expect(
      await test.store.validate(
        JOB_ID,
        first.checkpoint,
      ),
    ).toBe(true);

    expect(test.reconstruct).toHaveBeenCalledTimes(3);
  });

  it("rejects a changed upstream audio identity", async () => {
    const test = await fixture();

    const first = await test.store.run(JOB_ID);

    const changed = structuredClone(
      test.canonical,
    );

    changed.audioSha256 = "8".repeat(64);

    const {
      audioAlignedVisualHash: _ignored,
      ...payload
    } = changed;

    changed.audioAlignedVisualHash = hash(payload);

    test.reconstruct.mockResolvedValue(changed);

    await expect(
      test.store.run(JOB_ID),
    ).rejects.toThrow(
      "Persisted M6 visual is no longer canonical",
    );

    expect(
      await test.store.validate(
        JOB_ID,
        first.checkpoint,
      ),
    ).toBe(false);
  });

  it("rejects tampered persisted JSON", async () => {
    const test = await fixture();

    const first = await test.store.run(JOB_ID);

    const tampered = structuredClone(
      first.record,
    );

    tampered.visual.visual.totalFrames = 120;

    await writeFile(
      first.artifactPath,
      JSON.stringify(tampered),
    );

    await expect(
      test.store.run(JOB_ID),
    ).rejects.toThrow(
      "Persisted M6 visual integrity mismatch",
    );

    expect(
      await test.store.validate(
        JOB_ID,
        first.checkpoint,
      ),
    ).toBe(false);

    // Failed validation must not repair the file.
    const onDisk = JSON.parse(
      await readFile(first.artifactPath, "utf8"),
    );

    expect(onDisk.visual.visual.totalFrames).toBe(
      120,
    );
  });

  it("fails closed when reconstruction verification fails", async () => {
    const test = await fixture();

    const first = await test.store.run(JOB_ID);

    test.reconstruct.mockRejectedValue(
      new Error("Current media rights revoked"),
    );

    await expect(
      test.store.run(JOB_ID),
    ).rejects.toThrow(
      "Current media rights revoked",
    );

    expect(
      await test.store.validate(
        JOB_ID,
        first.checkpoint,
      ),
    ).toBe(false);
  });

  it("rejects checkpoint metadata tampering", async () => {
    const test = await fixture();

    const first = await test.store.run(JOB_ID);

    const tampered = {
      ...first.checkpoint,
      totalFrames: 999,
    };

    expect(
      await test.store.validate(
        JOB_ID,
        tampered,
      ),
    ).toBe(false);

    expect(
      await test.store.validate(
        JOB_ID,
        {
          ...first.checkpoint,
          artifactPath: "/wrong/path.json",
        },
      ),
    ).toBe(false);
  });

  it("supports concurrent identical publication", async () => {
    const test = await fixture();

    const secondStore =
      new PersistentAudioAlignedVisualStore(
        test.options,
      );

    const [first, second] = await Promise.all([
      test.store.run(JOB_ID),
      secondStore.run(JOB_ID),
    ]);

    expect(first.record.recordHash).toBe(
      second.record.recordHash,
    );

    const loaded = await test.store.load(JOB_ID);

    expect(loaded.record.recordHash).toBe(
      first.record.recordHash,
    );
  });
});
