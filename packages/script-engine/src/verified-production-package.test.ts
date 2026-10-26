import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";

import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  loadVerifiedProductionPackage,
  type VerifiedM3PackageAdapter,
} from "./verified-production-package.js";

type TestPackage = {
  storyboard: {
    title: string;
  };
  mediaPlan: {
    mode: "A" | "B" | "C" | "D";
    shots: Array<{
      shotId: string;
    }>;
  };
  packageHash: string;
};

const HASH = "a".repeat(64);

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function makePackage(): TestPackage {
  return {
    storyboard: {
      title: "Test documentary",
    },
    mediaPlan: {
      mode: "B",
      shots: [
        { shotId: "shot-001" },
        { shotId: "shot-002" },
      ],
    },
    packageHash: HASH,
  };
}

function makeEnvelope(
  packageValue = makePackage(),
) {
  return {
    version: 1 as const,
    jobId: "job-001",
    generationFingerprint: "test-fingerprint",
    sourceScriptHash: HASH,
    package: packageValue,
  };
}

describe("Verified M3 production package loader", () => {
  let directory: string | undefined;

  const verifyPackage = vi.fn(
    async (_value: TestPackage) => {},
  );

  const adapter: VerifiedM3PackageAdapter<TestPackage> = {
    parseEnvelope(input) {
      const value = input as ReturnType<
        typeof makeEnvelope
      >;

      if (value.version !== 1) {
        throw new Error("Invalid envelope");
      }

      return value;
    },

    verifyPackage,

    hashCanonical: hash,

    getMediaPlan: (value) =>
      value.mediaPlan,

    getStoryboard: (value) =>
      value.storyboard,

    getPackageHash: (value) =>
      value.packageHash,
  };

  async function setup(
    envelope: unknown = makeEnvelope(),
  ) {
    directory = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-verified-m3-",
      ),
    );

    const storyboardDir = path.join(
      directory,
      "storyboard",
    );

    await mkdir(storyboardDir);

    await writeFile(
      path.join(
        storyboardDir,
        "production-package.json",
      ),
      JSON.stringify(envelope),
    );

    return directory;
  }

  afterEach(async () => {
    verifyPackage.mockReset();

    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true,
      });

      directory = undefined;
    }
  });

  it("loads the authoritative shot IDs and mode", async () => {
    const root = await setup();

    const result =
      await loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        expectedMode: "B",
        adapter,
      });

    expect(result.mode).toBe("B");

    expect(result.shotIds).toEqual([
      "shot-001",
      "shot-002",
    ]);

    expect(result.packageHash).toBe(HASH);

    expect(verifyPackage)
      .toHaveBeenCalledTimes(1);
  });

  it("derives deterministic canonical hashes", async () => {
    const root = await setup();

    const first =
      await loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        adapter,
      });

    const second =
      await loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        adapter,
      });

    expect(first.storyboardSha256).toBe(
      second.storyboardSha256,
    );

    expect(first.mediaPlanSha256).toBe(
      second.mediaPlanSha256,
    );

    expect(first.storyboardSha256)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a mismatched job ID", async () => {
    const root = await setup();

    await expect(
      loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "another-job",
        adapter,
      }),
    ).rejects.toThrow(
      "job ID mismatch",
    );
  });

  it("rejects an unexpected media mode", async () => {
    const root = await setup();

    await expect(
      loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        expectedMode: "C",
        adapter,
      }),
    ).rejects.toThrow(
      "media mode",
    );
  });

  it("rejects duplicate shot IDs", async () => {
    const packageValue = makePackage();

    packageValue.mediaPlan.shots = [
      { shotId: "shot-001" },
      { shotId: "shot-001" },
    ];

    const root = await setup(
      makeEnvelope(packageValue),
    );

    await expect(
      loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        adapter,
      }),
    ).rejects.toThrow(
      "duplicate shot IDs",
    );
  });

  it("rejects a missing media plan", async () => {
    const invalid = makeEnvelope() as unknown as {
      package: Record<string, unknown>;
    };

    delete invalid.package.mediaPlan;

    const root = await setup(invalid);

    await expect(
      loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        adapter,
      }),
    ).rejects.toThrow();
  });

  it("fails when the authoritative M3 verifier fails", async () => {
    const root = await setup();

    verifyPackage.mockRejectedValueOnce(
      new Error("M3 package checksum mismatch"),
    );

    await expect(
      loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        adapter,
      }),
    ).rejects.toThrow(
      "M3 package checksum mismatch",
    );
  });

  it("rejects missing production artifacts", async () => {
    const root = await setup();

    await rm(
      path.join(
        root,
        "storyboard",
        "production-package.json",
      ),
    );

    await expect(
      loadVerifiedProductionPackage({
        jobDirectory: root,
        jobId: "job-001",
        adapter,
      }),
    ).rejects.toThrow();
  });
});
