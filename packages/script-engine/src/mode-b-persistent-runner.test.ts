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

import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  ModeBPersistentRunner,
  type ModeBProductionPackage,
} from "./mode-b-persistent-runner.js";

import type {
  PersistentMediaInput,
} from "./persistent-media-resolution.js";

import type {
  MediaCandidateProvider,
} from "./media-resolver.js";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
} from "./scene-media-plan.js";

import {
  storyboard,
} from "./visual-continuity.test-fixture.js";

const JOB_ID = "job-mode-b-001";
const HASH = "a".repeat(64);

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function makePackage(): ModeBProductionPackage {
  const continuity = planVisualContinuity(
    storyboard,
    "documentary",
  );

  return {
    storyboard,

    mediaPlan: createSceneMediaPlan(
      storyboard,
      continuity,
      "B",
    ),

    packageHash: HASH,
  };
}

describe("Mode B persistent runner", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-mode-b-runner-",
      ),
    );

    const jobDirectory = path.join(
      root,
      "job",
    );

    await mkdir(
      path.join(jobDirectory, "storyboard"),
      { recursive: true },
    );

    const pkg = makePackage();

    await writeFile(
      path.join(
        jobDirectory,
        "storyboard",
        "production-package.json",
      ),
      JSON.stringify({
        version: 1,
        jobId: JOB_ID,
        generationFingerprint: "fixture",
        sourceScriptHash: HASH,
        package: pkg,
      }),
    );

    const search = vi.fn(
      async () => [],
    );

    const provider: MediaCandidateProvider = {
      id: "offline-provider",
      supports: () => true,
      search,
    };

    const runner = new ModeBPersistentRunner({
      storageRoot: path.join(root, "storage"),

      jobDirectory: () => jobDirectory,

      m3Adapter: {
        parseEnvelope: (value: unknown) =>
          value as {
            version: 1;
            jobId: string;
            package: ModeBProductionPackage;
          },

        // Test-only adapter.
        // Production must call the real M3 verifier.
        verifyPackage: () => {},

        hashCanonical: hash,

        getMediaPlan: (value) =>
          value.mediaPlan,

        getStoryboard: (value) =>
          value.storyboard,

        getPackageHash: (value) =>
          value.packageHash,
      },

      providers: () => [provider],

      allowedLocalRoots: () => [
        path.join(root!, "uploads"),
      ],
    });

    const input: PersistentMediaInput = {
      jobId: JOB_ID,
      storyboardSha256: hash(pkg.storyboard),
      mediaPlanSha256: hash(pkg.mediaPlan),
      stageVersion: "m4-resolution-v1",

      request: {
        jobId: JOB_ID,
        mode: "B",
        shotIds: pkg.mediaPlan.shots.map(
          (shot) => shot.shotId,
        ),
      },
    };

    return {
      runner,
      input,
      search,
    };
  }

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = undefined;
    }
  });

  it("rejects a modified storyboard hash", async () => {
    const env = await setup();

    await expect(
      env.runner.run({
        ...env.input,
        storyboardSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(
      "authoritative M3 hashes",
    );

    expect(env.search).not.toHaveBeenCalled();
  });

  it("rejects a modified media-plan hash", async () => {
    const env = await setup();

    await expect(
      env.runner.run({
        ...env.input,
        mediaPlanSha256: "e".repeat(64),
      }),
    ).rejects.toThrow(
      "authoritative M3 hashes",
    );

    expect(env.search).not.toHaveBeenCalled();
  });

  it("rejects changed authoritative shot IDs", async () => {
    const env = await setup();

    await expect(
      env.runner.run({
        ...env.input,

        request: {
          ...env.input.request,
          shotIds: ["unauthorized-shot"],
        },
      }),
    ).rejects.toThrow(
      "authoritative M3 shots",
    );

    expect(env.search).not.toHaveBeenCalled();
  });

  it("rejects non-Mode-B requests", async () => {
    const env = await setup();

    await expect(
      env.runner.run({
        ...env.input,

        request: {
          jobId: JOB_ID,
          mode: "C",
          shotIds: env.input.request.shotIds,
          allowPaidGeneration: true,
        },
      }),
    ).rejects.toThrow(
      "cannot execute another media mode",
    );

    expect(env.search).not.toHaveBeenCalled();
  });
});
