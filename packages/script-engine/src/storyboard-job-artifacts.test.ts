import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  createStoryboardProductionPackage,
} from "./storyboard-production-package.js";

import {
  getStoryboardArtifactPath,
  loadStoryboardJobArtifact,
  saveStoryboardJobArtifact,
} from "./storyboard-job-artifacts.js";

import {
  productionFixture,
} from "./storyboard-production.test-fixture.js";

const JOB_ID = "storyboard-test";
const FINGERPRINT = "a".repeat(64);

describe("Storyboard job artifact persistence", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-storyboard-",
      ),
    );

    const productionPackage =
      createStoryboardProductionPackage(
        productionFixture(),
      );

    const filename = await saveStoryboardJobArtifact({
      jobsRoot: root,
      jobId: JOB_ID,
      generationFingerprint: FINGERPRINT,
      package: productionPackage,
    });

    return {
      filename,
      productionPackage,
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

  it("saves and reloads a verified package", async () => {
    const { productionPackage } = await setup();

    const result = await loadStoryboardJobArtifact({
      jobsRoot: root!,
      jobId: JOB_ID,
      expectedGenerationFingerprint: FINGERPRINT,
      expectedScriptHash:
        productionPackage.scriptHash,
    });

    expect(result.package.packageHash).toBe(
      productionPackage.packageHash,
    );

    expect(result.jobId).toBe(JOB_ID);
  });

  it("does not overwrite an existing artifact", async () => {
    const { filename, productionPackage } =
      await setup();

    const originalBytes = await readFile(
      filename,
      "utf8",
    );

    await expect(
      saveStoryboardJobArtifact({
        jobsRoot: root!,
        jobId: JOB_ID,
        generationFingerprint: FINGERPRINT,
        package: productionPackage,
      }),
    ).rejects.toThrow();

    expect(
      await readFile(filename, "utf8"),
    ).toBe(originalBytes);
  });

  it("rejects a changed generation fingerprint", async () => {
    const { productionPackage } = await setup();

    await expect(
      loadStoryboardJobArtifact({
        jobsRoot: root!,
        jobId: JOB_ID,
        expectedGenerationFingerprint:
          "b".repeat(64),
        expectedScriptHash:
          productionPackage.scriptHash,
      }),
    ).rejects.toThrow(
      "generation fingerprint mismatch",
    );
  });

  it("rejects a different source script hash", async () => {
    await setup();

    await expect(
      loadStoryboardJobArtifact({
        jobsRoot: root!,
        jobId: JOB_ID,
        expectedGenerationFingerprint: FINGERPRINT,
        expectedScriptHash:
          "b".repeat(64),
      }),
    ).rejects.toThrow(
      "source script hash mismatch",
    );
  });

  it("detects corrupted saved package contents", async () => {
    await setup();

    const filename = getStoryboardArtifactPath(
      root!,
      JOB_ID,
    );

    const saved = JSON.parse(
      await readFile(filename, "utf8"),
    );

    saved.package.storyboard.sections[0]
      .scenes[0].shots[0].narrationText =
      "Corrupted narration.";

    await writeFile(
      filename,
      JSON.stringify(saved),
      "utf8",
    );

    await expect(
      loadStoryboardJobArtifact({
        jobsRoot: root!,
        jobId: JOB_ID,
        expectedGenerationFingerprint: FINGERPRINT,
        expectedScriptHash:
          saved.sourceScriptHash,
      }),
    ).rejects.toThrow(
      "integrity mismatch",
    );
  });

  it("rejects unsafe job identifiers", async () => {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-storyboard-",
      ),
    );

    expect(() =>
      getStoryboardArtifactPath(
        root!,
        "../outside",
      ),
    ).toThrow();
  });
});
