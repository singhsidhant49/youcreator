import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import type {
  MediaAsset,
} from "@youcreator/contracts";

import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  PersistentMediaResolutionStage,
  createMediaStageInputHash,
  type PersistentMediaInput,
} from "./persistent-media-resolution.js";

const input: PersistentMediaInput = {
  jobId: "job-m4-001",
  storyboardSha256: "a".repeat(64),
  mediaPlanSha256: "b".repeat(64),
  stageVersion: "m4-resolution-v1",
  request: {
    jobId: "job-m4-001",
    mode: "B",
    shotIds: ["shot-001", "shot-002"],
  },
};

function makeAsset(letter: string): MediaAsset {
  return {
    version: 1,
    id: `asset-${letter}`,
    kind: "image",
    localPath: `/test/${letter}.png`,
    sha256: letter.repeat(64),
    bytes: 100,
    mimeType: "image/png",
    width: 1920,
    height: 1080,
    provenance: {
      source: "local_library",
      license: {
        status: "unknown",
      },
    },
    createdAt: "2026-10-12T10:00:00.000Z",
  };
}

function makeReport(): MediaResolutionReport {
  const assignments = [
    {
      version: 1 as const,
      shotId: "shot-001",
      mode: "B" as const,
      assignmentSource: "local_library" as const,
      asset: makeAsset("c"),
      assignedAt: "2026-10-12T10:00:00.000Z",
    },
    {
      version: 1 as const,
      shotId: "shot-002",
      mode: "B" as const,
      assignmentSource: "local_library" as const,
      asset: makeAsset("d"),
      assignedAt: "2026-10-12T10:00:00.000Z",
    },
  ];

  return {
    version: 1,
    jobId: "job-m4-001",
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
}

describe("Persistent media resolution", () => {
  let root: string | undefined;

  async function setup(
    options: {
      report?: MediaResolutionReport;
      verify?: boolean;
      rights?:
        | "approved"
        | "review_required"
        | "rejected";
    } = {},
  ) {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m4-stage-",
      ),
    );

    const coordinatorRun = vi.fn(
      async () =>
        options.report ?? makeReport(),
    );

    const verify = vi.fn(
      async (_asset: MediaAsset) =>
        options.verify ?? true,
    );

    const rights = vi.fn(
      async (_asset: MediaAsset) =>
        options.rights ?? "approved" as const,
    );

    const createStage = () =>
      new PersistentMediaResolutionStage({
        storageRoot: root!,
        coordinator: {
          run: coordinatorRun,
        },
        assetVerifier: {
          verify,
        },
        rightsChecker: {
          check: rights,
        },
      });

    return {
      stage: createStage(),
      createStage,
      coordinatorRun,
      verify,
      rights,
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

  it("generates deterministic input hashes", () => {
    const original =
      createMediaStageInputHash(input);

    expect(original).toBe(
      createMediaStageInputHash(input),
    );

    expect(original).not.toBe(
      createMediaStageInputHash({
        ...input,
        mediaPlanSha256: "e".repeat(64),
      }),
    );
  });

  it("persists a successful resolution manifest", async () => {
    const env = await setup();

    const result = await env.stage.run(input);

    expect(result.reused).toBe(false);
    expect(result.manifest.inputHash).toBe(
      createMediaStageInputHash(input),
    );

    expect(result.manifest.report.assignedShots)
      .toBe(2);

    expect(env.coordinatorRun)
      .toHaveBeenCalledTimes(1);
  });

  it("reuses completed resolution without rerunning providers", async () => {
    const env = await setup();

    await env.stage.run(input);

    const recovered =
      await env.createStage().run(input);

    expect(recovered.reused).toBe(true);

    expect(env.coordinatorRun)
      .toHaveBeenCalledTimes(1);

    expect(env.verify.mock.calls.length)
      .toBeGreaterThan(2);
  });

  it("rejects changed stage inputs for an existing job", async () => {
    const env = await setup();

    await env.stage.run(input);

    await expect(
      env.stage.run({
        ...input,
        storyboardSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(
      "input changed",
    );

    expect(env.coordinatorRun)
      .toHaveBeenCalledTimes(1);
  });

  it("fails closed when cached asset verification fails", async () => {
    let valid = true;

    const env = await setup();

    const verify = env.verify;

    verify.mockImplementation(
      async () => valid,
    );

    await env.stage.run(input);

    valid = false;

    await expect(
      env.stage.run(input),
    ).rejects.toThrow(
      "verification failed",
    );

    expect(env.coordinatorRun)
      .toHaveBeenCalledTimes(1);
  });

  it("fails closed when cached rights are revoked", async () => {
    const env = await setup();

    let approved = true;

    env.rights.mockImplementation(
      async () =>
        approved
          ? "approved"
          : "rejected",
    );

    await env.stage.run(input);

    approved = false;

    await expect(
      env.stage.run(input),
    ).rejects.toThrow(
      "rights not approved",
    );

    expect(env.coordinatorRun)
      .toHaveBeenCalledTimes(1);
  });

  it("retains the attempt marker after coordinator failure", async () => {
    const failed = {
      ...makeReport(),
      passed: false,
      assignedShots: 0,
      assignments: [],
      outcomes: [],
      issues: [
        {
          code: "RESOLUTION_FAILED" as const,
          severity: "blocker" as const,
          shotId: "shot-001",
          message: "Provider unavailable",
        },
      ],
    };

    const env = await setup({
      report: failed,
    });

    await expect(
      env.stage.run(input),
    ).rejects.toThrow(
      "failed QA",
    );

    await expect(
      env.stage.run(input),
    ).rejects.toThrow(
      "manual recovery required",
    );

    expect(env.coordinatorRun)
      .toHaveBeenCalledTimes(1);
  });

  it("rejects corruption of the persisted manifest", async () => {
    const env = await setup();

    await env.stage.run(input);

    const base = path.join(
      root!,
      "media-resolution",
    );

    const directories = await readdir(base);

    const manifestPath = path.join(
      base,
      directories[0]!,
      "manifest.json",
    );

    const saved = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );

    saved.inputHash = "0".repeat(64);

    await writeFile(
      manifestPath,
      JSON.stringify(saved),
    );

    await expect(
      env.stage.run(input),
    ).rejects.toThrow(
      "input changed",
    );
  });
});
