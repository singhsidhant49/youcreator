import os from "node:os";
import path from "node:path";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createNativeTrustedVisualPreparation,
} from "./native-trusted-visual-preparation.js";

function options() {
  return {
    storageRoot: path.join(
      os.tmpdir(),
      "youcreator-m5-native-storage",
    ),

    jobDirectory(jobId: string) {
      return path.join(
        os.tmpdir(),
        "youcreator-m5-native-jobs",
        jobId,
      );
    },

    async loadStoryboardCheckpoint() {
      throw new Error(
        "Checkpoint unavailable in isolated test",
      );
    },

    extractTimings() {
      throw new Error(
        "No M3 production package in isolated test",
      );
    },
  };
}

describe("Native trusted visual preparation", () => {
  it("rejects a relative media storage root", () => {
    expect(() =>
      createNativeTrustedVisualPreparation({
        ...options(),
        storageRoot: "relative-media-storage",
      }),
    ).toThrow(
      "Native visual storage root must be absolute",
    );
  });

  it("rejects a relative job directory", async () => {
    const preparation =
      createNativeTrustedVisualPreparation({
        ...options(),

        jobDirectory(jobId) {
          return path.join(
            "relative-jobs",
            jobId,
          );
        },
      });

    await expect(
      preparation.prepare({
        jobId: "job-001",
      }),
    ).rejects.toThrow(
      "Native visual job directory must be absolute",
    );
  });

  it("fails closed when an M3 artifact is absent", async () => {
    const preparation =
      createNativeTrustedVisualPreparation(
        options(),
      );

    await expect(
      preparation.prepare({
        jobId: "nonexistent-m5-job",
      }),
    ).rejects.toThrow();
  });
});
