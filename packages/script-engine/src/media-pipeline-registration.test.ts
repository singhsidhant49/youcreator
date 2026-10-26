import {
  describe,
  expect,
  it,
} from "vitest";

import {
  registerMediaPipelineStage,
  getMediaResolutionManifestPath,
  getMediaResolutionAttemptPath,
  type MediaPipelineRegistrationStage,
} from "./media-pipeline-registration.js";

function mediaStage(): MediaPipelineRegistrationStage {
  return {
    id: "media",
    version: "m4-media-pipeline-v1",
    dependencies: ["storyboard"],
  };
}

describe("Native media pipeline registration", () => {
  it("registers media after storyboard", () => {
    const registry = {
      stages: ["script", "storyboard"],

      register(
        stage: MediaPipelineRegistrationStage,
      ) {
        this.stages.push(stage.id);
      },

      resolveOrder() {
        return [...this.stages];
      },
    };

    const registered =
      registerMediaPipelineStage({
        registry,
        stage: mediaStage(),
      });

    expect(registered.id).toBe("media");

    expect(
      registry.resolveOrder(),
    ).toEqual([
      "script",
      "storyboard",
      "media",
    ]);
  });

  it("rejects registration without storyboard", () => {
    const registry = {
      stages: ["script"],

      register(
        stage: MediaPipelineRegistrationStage,
      ) {
        this.stages.push(stage.id);
      },

      resolveOrder() {
        return [...this.stages];
      },
    };

    expect(() =>
      registerMediaPipelineStage({
        registry,
        stage: mediaStage(),
      }),
    ).toThrow(
      "Storyboard stage must be registered",
    );
  });

  it("rejects duplicate media registration", () => {
    const registry = {
      stages: [
        "script",
        "storyboard",
        "media",
      ],

      register() {
        throw new Error(
          "Should not register twice",
        );
      },

      resolveOrder() {
        return [...this.stages];
      },
    };

    expect(() =>
      registerMediaPipelineStage({
        registry,
        stage: mediaStage(),
      }),
    ).toThrow(
      "already registered",
    );
  });

  it("derives deterministic manifest and attempt paths", () => {
    const root = "/tmp/youcreator-storage";

    const first =
      getMediaResolutionManifestPath(
        root,
        "job-001",
      );

    const second =
      getMediaResolutionManifestPath(
        root,
        "job-001",
      );

    const another =
      getMediaResolutionManifestPath(
        root,
        "job-002",
      );

    expect(first).toBe(second);
    expect(first).not.toBe(another);

    expect(first).toMatch(
      /media-resolution\/[a-f0-9]{64}\/manifest\.json$/,
    );

    expect(
      getMediaResolutionAttemptPath(
        root,
        "job-001",
      ),
    ).toBe(
      first.replace(
        /manifest\.json$/,
        "attempt.json",
      ),
    );
  });
});
