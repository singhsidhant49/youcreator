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
  createRegisteredModeBMediaStage,
} from "./registered-mode-b-media-stage.js";

import {
  createAuthoritativeM3Adapter,
} from "./authoritative-m3-adapter.js";

function stage(
  id: "script" | "storyboard",
  dependencies: Array<
    "script" | "storyboard"
  > = [],
): PipelineStage {
  return {
    id,
    version: "test-stage-v1",
    dependencies,

    async execute() {
      return {
        completed: true,
      };
    },
  };
}

function options(registry: PipelineRegistry) {
  return {
    registry,

    storageRoot:
      "/tmp/youcreator-m4-test-store",

    jobDirectory(jobId: string) {
      return `/tmp/youcreator-m4-test-jobs/${jobId}`;
    },

    providers: () => [{
      id: "offline-provider",
      supports: () => true,
      search: async () => [],
    }],

    allowedLocalRoots: () => [
      "/tmp/youcreator-m4-test-bank",
    ],
  };
}

describe("Registered Mode B media stage", () => {
  it("registers in the real M1 pipeline registry", () => {
    const registry = new PipelineRegistry();

    registry.register(stage("script"));

    registry.register(
      stage("storyboard", ["script"]),
    );

    const media =
      createRegisteredModeBMediaStage(
        options(registry),
      );

    expect(media.id).toBe("media");

    expect(
      registry.resolveOrder().map(
        (entry) => entry.id,
      ),
    ).toEqual([
      "script",
      "storyboard",
      "media",
    ]);
  });

  it("rejects missing storyboard registration", () => {
    const registry = new PipelineRegistry();

    registry.register(stage("script"));

    expect(() =>
      createRegisteredModeBMediaStage(
        options(registry),
      ),
    ).toThrow(
      "Storyboard stage must be registered",
    );
  });

  it("rejects duplicate media registration", () => {
    const registry = new PipelineRegistry();

    registry.register(stage("script"));

    registry.register(
      stage("storyboard", ["script"]),
    );

    createRegisteredModeBMediaStage(
      options(registry),
    );

    expect(() =>
      createRegisteredModeBMediaStage(
        options(registry),
      ),
    ).toThrow(
      "already registered",
    );
  });

  it("rejects invalid saved M3 package data through the real verifier", async () => {
    const adapter =
      createAuthoritativeM3Adapter();

    await expect(
      adapter.verifyPackage({
        version: 1,
        storyboard: {},
        mediaPlan: {
          mode: "B",
          shots: [],
        },
        packageHash: "a".repeat(64),
      } as never),
    ).rejects.toThrow();
  });
});
