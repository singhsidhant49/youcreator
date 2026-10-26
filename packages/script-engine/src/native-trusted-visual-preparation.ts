import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  StoryboardProductionPackage,
} from "./storyboard-production-package.js";

import type {
  CanonicalShotTiming,
} from "./shot-frame-geometry.js";

import {
  createNativeM3VisualSource,
} from "./native-m3-visual-source.js";

import {
  createNativeM4VisualSource,
} from "./native-m4-visual-source.js";

import {
  assembleTrustedVisualPackage,
} from "./trusted-visual-artifact-assembly.js";

import type {
  AuthoritativeVisualResult,
  ExpectedVisualPackages,
} from "./authoritative-visual-reconstruction.js";

export interface NativeTrustedVisualPreparationOptions {
  storageRoot: string;

  /**
   * Must be the same resolver used by M1 JobExecutor.
   */
  jobDirectory(jobId: string): string;

  /**
   * Return the persisted M1 storyboard stage output,
   * not the CheckpointStore wrapper.
   */
  loadStoryboardCheckpoint(
    jobId: string,
    jobDirectory: string,
  ): Promise<unknown>;

  /**
   * Extract the real M3 authoritative timing records.
   * Must not estimate or synthesize durations.
   */
  extractTimings(
    productionPackage: StoryboardProductionPackage,
  ): CanonicalShotTiming[];

  fps?: number;
  frameWidth?: number;
  frameHeight?: number;
  expectedMode?: "A" | "B" | "C" | "D";
}

export interface PrepareNativeVisualJobInput {
  jobId: string;
  expected?: ExpectedVisualPackages;
}

export function createNativeTrustedVisualPreparation(
  options: NativeTrustedVisualPreparationOptions,
) {
  if (!path.isAbsolute(options.storageRoot)) {
    throw new Error(
      "Native visual storage root must be absolute",
    );
  }

  const m3 = createNativeM3VisualSource({
    loadStoryboardCheckpoint:
      options.loadStoryboardCheckpoint,

    extractTimings:
      options.extractTimings,

    expectedMode: options.expectedMode,
  });

  const m4 = createNativeM4VisualSource({
    storageRoot: options.storageRoot,
    jobDirectory: options.jobDirectory,
    expectedMode: options.expectedMode,
  });

  return {
    async prepare(
      input: PrepareNativeVisualJobInput,
    ): Promise<AuthoritativeVisualResult> {
      const jobDirectory =
        options.jobDirectory(input.jobId);

      if (!path.isAbsolute(jobDirectory)) {
        throw new Error(
          "Native visual job directory must be absolute",
        );
      }

      let effectiveFps = options.fps;
      let effectiveWidth = options.frameWidth;
      let effectiveHeight = options.frameHeight;

      try {
        const jobFile = path.join(path.dirname(jobDirectory), `${input.jobId}.json`);
        const content = await readFile(jobFile, "utf8");
        const jobData = JSON.parse(content);
        if (jobData?.config?.fps) {
          effectiveFps = jobData.config.fps;
        }
        if (jobData?.config?.resolution) {
          const parts = String(jobData.config.resolution).split("x").map(Number);
          if (parts[0] && parts[1]) {
            effectiveWidth = parts[0];
            effectiveHeight = parts[1];
          }
        }
      } catch {
        // Fall back to configured options
      }

      return assembleTrustedVisualPackage({
        jobId: input.jobId,
        jobDirectory,
        storageRoot: options.storageRoot,

        sources: {
          m3,
          m4,
        },

        fps: effectiveFps,
        frameWidth: effectiveWidth,
        frameHeight: effectiveHeight,

        expected: input.expected,
      });
    },
  };
}
