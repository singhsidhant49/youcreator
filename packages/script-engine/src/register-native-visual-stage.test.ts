import os from "node:os";
import path from "node:path";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  PipelineRegistry,
  type PipelineStage,
} from "@youcreator/core";

import {
  registerNativeVisualStage,
} from "./register-native-visual-stage.js";

function stage(
  id: "script" | "storyboard" | "media",
  dependencies: Array<
    "script" | "storyboard" | "media"
  > = [],
): PipelineStage {
  return {
    id,
    version: "test-upstream-v1",
    dependencies,

    async execute() {
      return { completed: true };
    },
  };
}

function registryWithMedia() {
  const registry = new PipelineRegistry();

  registry.register(stage("script"));

  registry.register(
    stage("storyboard", ["script"]),
  );

  registry.register(
    stage("media", ["storyboard"]),
  );

  return registry;
}

function options(registry: PipelineRegistry) {
  return {
    registry,

    storageRoot: path.join(
      os.tmpdir(),
      "youcreator-m5-register-storage",
    ),

    jobDirectory(jobId: string) {
      return path.join(
        os.tmpdir(),
        "youcreator-m5-register-jobs",
        jobId,
      );
    },

    async loadStoryboardCheckpoint() {
      throw new Error(
        "No checkpoint in registration unit test",
      );
    },

    extractTimings() {
      throw new Error(
        "No storyboard in registration unit test",
      );
    },
  };
}

describe("Native visual stage registration", () => {
  it("registers in canonical four-stage order", () => {
    const registry = registryWithMedia();

    const result = registerNativeVisualStage(
      options(registry),
    );

    expect(result.stage.id).toBe("visual");

    expect(
      registry.resolveOrder().map(
        (stage) => stage.id,
      ),
    ).toEqual([
      "script",
      "storyboard",
      "media",
      "visual",
    ]);
  });

  it("rejects missing media registration", () => {
    const registry = new PipelineRegistry();

    registry.register(stage("script"));

    registry.register(
      stage("storyboard", ["script"]),
    );

    expect(() =>
      registerNativeVisualStage(
        options(registry),
      ),
    ).toThrow(
      "Media stage must be registered",
    );
  });

  it("rejects duplicate visual registration", () => {
    const registry = registryWithMedia();

    registerNativeVisualStage(
      options(registry),
    );

    expect(() =>
      registerNativeVisualStage(
        options(registry),
      ),
    ).toThrow(
      "Visual stage is already registered",
    );
  });
});
