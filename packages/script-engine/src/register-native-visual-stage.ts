import path from "node:path";

import {
  type PipelineRegistry,
} from "@youcreator/core";

import type {
  StoryboardProductionPackage,
} from "./storyboard-production-package.js";

import type {
  CanonicalShotTiming,
} from "./shot-frame-geometry.js";

import {
  createNativeTrustedVisualPreparation,
} from "./native-trusted-visual-preparation.js";

import {
  PersistentVisualPackageStore,
} from "./persistent-visual-package.js";

import {
  createVisualPipelineStage,
} from "./visual-pipeline-stage.js";

export interface RegisterNativeVisualStageOptions {
  registry: PipelineRegistry;

  storageRoot: string;

  jobDirectory(jobId: string): string;

  loadStoryboardCheckpoint(
    jobId: string,
    jobDirectory: string,
  ): Promise<unknown>;

  extractTimings(
    productionPackage: StoryboardProductionPackage,
  ): CanonicalShotTiming[];

  fps?: number;
  frameWidth?: number;
  frameHeight?: number;
  expectedMode?: "A" | "B" | "C" | "D";
}

export function registerNativeVisualStage(
  options: RegisterNativeVisualStageOptions,
) {
  if (!path.isAbsolute(options.storageRoot)) {
    throw new Error(
      "Visual stage requires an absolute storage root",
    );
  }

  // Media must already exist in the native registry.
  const registered =
    options.registry.resolveOrder();

  const mediaIndex = registered.findIndex(
    (stage) => stage.id === "media",
  );

  if (mediaIndex < 0) {
    throw new Error(
      "Media stage must be registered before visual",
    );
  }

  if (
    registered.some(
      (stage) => stage.id === "visual",
    )
  ) {
    throw new Error(
      "Visual stage is already registered",
    );
  }

  const preparation =
    createNativeTrustedVisualPreparation({
      storageRoot: options.storageRoot,

      jobDirectory: options.jobDirectory,

      loadStoryboardCheckpoint:
        options.loadStoryboardCheckpoint,

      extractTimings:
        options.extractTimings,

      fps: options.fps,
      frameWidth: options.frameWidth,
      frameHeight: options.frameHeight,
      expectedMode: options.expectedMode,
    });

  const store =
    new PersistentVisualPackageStore({
      jobDirectory: options.jobDirectory,
      preparation,
    });

  const stage = createVisualPipelineStage({
    store,
    jobDirectory: options.jobDirectory,
  });

  options.registry.register(stage);

  const order = options.registry.resolveOrder();

  const actualMediaIndex = order.findIndex(
    (entry) => entry.id === "media",
  );

  const visualIndex = order.findIndex(
    (entry) => entry.id === "visual",
  );

  if (
    actualMediaIndex < 0 ||
    visualIndex <= actualMediaIndex
  ) {
    throw new Error(
      "Invalid visual pipeline dependency order",
    );
  }

  return {
    stage,
    store,
    preparation,
  };
}
