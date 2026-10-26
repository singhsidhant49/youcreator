import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  mkdtemp,
  rm,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  createModeBMediaServices,
} from "./mode-b-media-services.js";

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

function requirements() {
  const continuity = planVisualContinuity(
    storyboard,
    "documentary",
  );

  return createSceneMediaPlan(
    storyboard,
    continuity,
    "B",
  ).shots;
}

describe("Mode B production media composition", () => {
  it("rejects missing discovery providers", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-mode-b-"),
    );

    try {
      expect(() =>
        createModeBMediaServices({
          jobId: "job-001",
          requirements: requirements(),
          storageRoot: root,
          allowedLocalRoots: [root],
          providers: [],
        }),
      ).toThrow(
        "at least one media discovery provider",
      );
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("constructs services without invoking discovery", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-mode-b-"),
    );

    const search = vi.fn(
      async () => [],
    );

    const provider: MediaCandidateProvider = {
      id: "offline-test-provider",
      supports: () => true,
      search,
    };

    try {
      const services = createModeBMediaServices({
        jobId: "job-001",
        requirements: requirements(),
        storageRoot: root,
        allowedLocalRoots: [root],
        providers: [provider],
      });

      expect(services.stockResolver).toBeDefined();
      expect(services.coordinator).toBeDefined();
      expect(services.persistentStage).toBeDefined();
      expect(services.objectStore).toBeDefined();
      expect(services.rightsStore).toBeDefined();

      expect(search).not.toHaveBeenCalled();
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("does not enable paid AI generation", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-mode-b-"),
    );

    const search = vi.fn(
      async () => [],
    );

    try {
      const services = createModeBMediaServices({
        jobId: "job-001",
        requirements: requirements(),
        storageRoot: root,
        allowedLocalRoots: [root],
        providers: [{
          id: "offline-local",
          supports: () => true,
          search,
        }],
      });

      const result = await services.coordinator.run({
        jobId: "job-001",
        mode: "C",
        shotIds: [
          requirements()[0]!.shotId,
        ],
        allowPaidGeneration: true,
      });

      expect(result.passed).toBe(false);

      expect(
        result.issues.some(
          (issue) =>
            issue.code === "RESOLUTION_FAILED",
        ),
      ).toBe(true);

      expect(search).not.toHaveBeenCalled();
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });
});
