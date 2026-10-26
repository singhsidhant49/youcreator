import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  inspectMediaCheckpoint,
} from "./media-checkpoint-integrity.js";

describe("Media checkpoint inspection", () => {
  let root: string | undefined;

  async function fixture(
    overrides: {
      shotIds?: string[];
      passed?: boolean;
    } = {},
  ) {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m4-inspection-",
      ),
    );

    const filename = path.join(
      root,
      "manifest.json",
    );

    const shotIds =
      overrides.shotIds ?? [
        "shot-001",
        "shot-002",
      ];

    const assignments = shotIds.map(
      (shotId, index) => ({
        version: 1,
        shotId,
        mode: "B",
        assignmentSource: "local_library",
        assignedAt:
          "2026-10-12T10:00:00.000Z",

        asset: {
          version: 1,
          id: `asset-${index}`,
          kind: "image",

          localPath: `/objects/${index}.png`,
          sha256: String(index + 1).repeat(64),

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

          createdAt:
            "2026-10-12T10:00:00.000Z",
        },
      }),
    );

    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        jobId: "job-001",
        inputHash: "a".repeat(64),

        report: {
          passed: overrides.passed ?? true,
          assignments,
        },
      }),
    );

    return filename;
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

  it("extracts persisted assignment identity", async () => {
    const filename = await fixture();

    const result = await inspectMediaCheckpoint(
      filename,
    );

    expect(result.jobId).toBe("job-001");

    expect(result.shotIds).toEqual([
      "shot-001",
      "shot-002",
    ]);

    expect(result.assetPaths).toEqual([
      "/objects/0.png",
      "/objects/1.png",
    ]);

    expect(result.manifestHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects duplicate assigned shot IDs", async () => {
    const filename = await fixture({
      shotIds: [
        "shot-001",
        "shot-001",
      ],
    });

    await expect(
      inspectMediaCheckpoint(filename),
    ).rejects.toThrow(
      "duplicate shot assignments",
    );
  });

  it("does not accept an unsuccessful report", async () => {
    const filename = await fixture({
      passed: false,
    });

    await expect(
      inspectMediaCheckpoint(filename),
    ).rejects.toThrow();
  });
});
