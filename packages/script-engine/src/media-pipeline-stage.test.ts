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
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  createMediaPipelineStage,
} from "./media-pipeline-stage.js";

import type {
  PersistentMediaInput,
  PersistentMediaManifest,
} from "./persistent-media-resolution.js";

import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

type TestPackage = {
  storyboard: { title: string };
  mediaPlan: {
    mode: "B";
    shots: { shotId: string }[];
  };
  packageHash: string;
};

type TestContext = {
  jobId: string;
  jobDirectory: string;
  mode: "B";
};

const HASH = "a".repeat(64);

function hash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

describe("Native M1 media pipeline stage", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-media-stage-"),
    );

    await mkdir(
      path.join(root, "storyboard"),
    );

    await mkdir(
      path.join(root, "media"),
    );

    const pkg: TestPackage = {
      storyboard: { title: "Test video" },
      mediaPlan: {
        mode: "B",
        shots: [{ shotId: "shot-001" }],
      },
      packageHash: HASH,
    };

    await writeFile(
      path.join(
        root,
        "storyboard",
        "production-package.json",
      ),
      JSON.stringify({
        version: 1,
        jobId: "job-001",
        generationFingerprint: "fixture",
        sourceScriptHash: HASH,
        package: pkg,
      }),
    );

    const context: TestContext = {
      jobId: "job-001",
      jobDirectory: root,
      mode: "B",
    };

    const manifestPath = path.join(
      root,
      "media",
      "manifest.json",
    );

    const report: MediaResolutionReport = {
      version: 1,
      jobId: "job-001",
      mode: "B",
      expectedShots: 1,
      assignedShots: 1,
      outcomes: [{
        status: "assigned",
        assignment: {
          version: 1,
          shotId: "shot-001",
          mode: "B",
          assignmentSource: "local_library",
          assignedAt:
            "2026-10-12T10:00:00.000Z",
          asset: {
            version: 1,
            id: "asset-001",
            kind: "image",
            localPath: "/test/image.png",
            sha256: "b".repeat(64),
            bytes: 100,
            mimeType: "image/png",
            width: 1920,
            height: 1080,
            provenance: {
              source: "local_library",
              license: { status: "unknown" },
            },
            createdAt:
              "2026-10-12T10:00:00.000Z",
          },
        },
      }],
      assignments: [],
      issues: [],
      passed: true,
    };

    if (report.outcomes[0]?.status === "assigned") {
      report.assignments = [
        report.outcomes[0].assignment,
      ];
    }

    let persisted = false;

    const persistentRun = vi.fn(
      async (
        input: PersistentMediaInput,
      ): Promise<{
        reused: boolean;
        manifest: PersistentMediaManifest;
      }> => {
        if (!persisted) {
          persisted = true;
        }

        const manifest: PersistentMediaManifest = {
          version: 1,
          inputHash: hash(input),
          jobId: input.jobId,
          storyboardSha256:
            input.storyboardSha256,
          mediaPlanSha256:
            input.mediaPlanSha256,
          stageVersion: "m4-resolution-v1",
          report,
          completedAt:
            "2026-10-12T10:00:00.000Z",
        };

        await writeFile(
          manifestPath,
          JSON.stringify(manifest),
        );

        return {
          reused: persistentRun.mock.calls.length > 1,
          manifest,
        };
      },
    );

    const stage = createMediaPipelineStage({
      contextAdapter: {
        getJobId: (ctx: TestContext) =>
          ctx.jobId,
        getJobDirectory: (ctx: TestContext) =>
          ctx.jobDirectory,
        getExpectedMode: (ctx: TestContext) =>
          ctx.mode,
        buildRequest: (
          _ctx: TestContext,
          verified,
        ) => ({
          jobId: verified.jobId,
          mode: "B" as const,
          shotIds: verified.shotIds,
        }),
      },
      m3Adapter: {
        parseEnvelope: (value: unknown) =>
          value as {
            version: 1;
            jobId: string;
            package: TestPackage;
          },
        verifyPackage: () => {},
        hashCanonical: hash,
        getMediaPlan: (value: TestPackage) =>
          value.mediaPlan,
        getStoryboard: (value: TestPackage) =>
          value.storyboard,
        getPackageHash: (value: TestPackage) =>
          value.packageHash,
      },
      persistentStage: {
        run: persistentRun,
      },
      manifestPath: () => manifestPath,
    });

    return {
      stage,
      context,
      persistentRun,
      manifestPath,
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

  it("exposes the canonical M1 media stage", async () => {
    const env = await setup();

    expect(env.stage.id).toBe("media");
    expect(env.stage.dependencies)
      .toEqual(["storyboard"]);

    expect(env.stage.version)
      .toBe("m4-media-pipeline-v1");
  });

  it("executes and persists a compact checkpoint output", async () => {
    const env = await setup();

    const output = await env.stage.execute(
      env.context,
    );

    expect(output).toMatchObject({
      jobId: "job-001",
      mode: "B",
      shotCount: 1,
      assignedCount: 1,
    });

    expect(output.manifestHash)
      .toMatch(/^[a-f0-9]{64}$/);

    expect(env.persistentRun)
      .toHaveBeenCalledTimes(1);
  });

  it("revalidates an existing media checkpoint", async () => {
    const env = await setup();

    const output = await env.stage.execute(
      env.context,
    );

    const valid =
      await env.stage.validateOutput(
        output,
        env.context,
      );

    expect(valid).toBe(true);
    expect(env.persistentRun)
      .toHaveBeenCalledTimes(2);
  });

  it("rejects a corrupted manifest checkpoint", async () => {
    const env = await setup();

    const output = await env.stage.execute(
      env.context,
    );

    const manifest = JSON.parse(
      await readFile(
        env.manifestPath,
        "utf8",
      ),
    );

    manifest.inputHash = "0".repeat(64);

    await writeFile(
      env.manifestPath,
      JSON.stringify(manifest),
    );

    const valid =
      await env.stage.validateOutput(
        output,
        env.context,
      );

    expect(valid).toBe(false);

    expect(env.persistentRun)
      .toHaveBeenCalledTimes(1);
  });

  it("rejects an M3 mode mismatch before resolution", async () => {
    const env = await setup();

    const invalidContext = {
      ...env.context,
      mode: "C" as "B",
    };

    await expect(
      env.stage.execute(invalidContext),
    ).rejects.toThrow(
      "media mode",
    );

    expect(env.persistentRun)
      .not.toHaveBeenCalled();
  });
});
