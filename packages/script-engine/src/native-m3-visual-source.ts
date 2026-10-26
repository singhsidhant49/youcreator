import path from "node:path";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  StoryboardStageOutputSchema,
} from "./storyboard-pipeline-stage.js";

import {
  StoryboardArtifactEnvelopeSchema,
} from "./storyboard-job-artifacts.js";

import {
  createAuthoritativeM3Adapter,
} from "./authoritative-m3-adapter.js";

import {
  loadVerifiedProductionPackage,
} from "./verified-production-package.js";

import type {
  StoryboardProductionPackage,
} from "./storyboard-production-package.js";

import type {
  CanonicalShotTiming,
} from "./shot-frame-geometry.js";

import type {
  VerifiedM3VisualSource,
} from "./trusted-visual-artifact-assembly.js";

const TimingSchema = z.object({
  shotId: z.string().min(1),
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
}).strict();

export interface NativeM3VisualSourceOptions {
  /**
   * Load the actual M1 storyboard checkpoint.
   *
   * Implement this with the existing CheckpointStore,
   * not by reconstructing a checkpoint from M3.
   */
  loadStoryboardCheckpoint(
    jobId: string,
    jobDirectory: string,
  ): Promise<unknown>;

  /**
   * Extract timings from the verified production
   * package's authoritative timeline.
   *
   * This function must not generate new timings or
   * estimate durations from narration text.
   */
  extractTimings(
    productionPackage: StoryboardProductionPackage,
  ): CanonicalShotTiming[];

  expectedMode?: "A" | "B" | "C" | "D";
}

export function validateNativeM3Timings(
  shotIds: readonly string[],
  input: unknown,
): CanonicalShotTiming[] {
  if (
    shotIds.length === 0 ||
    new Set(shotIds).size !== shotIds.length
  ) {
    throw new Error(
      "Native M3 shot IDs are empty or duplicated",
    );
  }

  const timings = z.array(
    TimingSchema,
  ).parse(input);

  if (timings.length !== shotIds.length) {
    throw new Error(
      "Native M3 timing coverage mismatch",
    );
  }

  let previousEnd = 0;

  for (let index = 0; index < timings.length; index++) {
    const timing = timings[index]!;

    if (timing.shotId !== shotIds[index]) {
      throw new Error(
        `Native M3 shot order mismatch at ${index}`,
      );
    }

    if (timing.endSeconds <= timing.startSeconds) {
      throw new Error(
        `Native M3 invalid duration: ${timing.shotId}`,
      );
    }

    if (
      Math.abs(
        timing.startSeconds - previousEnd,
      ) > 0.00001
    ) {
      throw new Error(
        `Native M3 timeline discontinuity: ${timing.shotId}`,
      );
    }

    previousEnd = timing.endSeconds;
  }

  return timings;
}

export function createNativeM3VisualSource(
  options: NativeM3VisualSourceOptions,
): VerifiedM3VisualSource {
  const adapter = createAuthoritativeM3Adapter();

  return {
    async load({ jobId, jobDirectory }) {
      if (!path.isAbsolute(jobDirectory)) {
        throw new Error(
          "Native M3 job directory must be absolute",
        );
      }

      // 1. Authenticate the saved M3 package.
      const verified =
        await loadVerifiedProductionPackage({
          jobId,
          jobDirectory,
          expectedMode: options.expectedMode,
          adapter,
        });

      // 2. Load and validate the genuine M1 checkpoint.
      const checkpointRaw =
        await options.loadStoryboardCheckpoint(
          jobId,
          jobDirectory,
        );

      const checkpoint =
        StoryboardStageOutputSchema.parse(
          checkpointRaw,
        );

      // 3. Require exact artifact and package identity.
      const expectedArtifactPath = path.join(
        jobDirectory,
        "storyboard",
        "production-package.json",
      );

      if (
        path.resolve(verified.artifactPath) !==
          path.resolve(expectedArtifactPath) ||
        path.resolve(checkpoint.artifactPath) !==
          path.resolve(expectedArtifactPath) ||
        checkpoint.packageHash !==
          verified.packageHash ||
        checkpoint.scriptHash !==
          verified.package.scriptHash
      ) {
        throw new Error(
          "Native M3 storyboard checkpoint mismatch",
        );
      }

      // 4. Verify the actual persisted envelope.
      const envelope =
        StoryboardArtifactEnvelopeSchema.parse(
          JSON.parse(
            await readFile(
              verified.artifactPath,
              "utf8",
            ),
          ),
        );

      if (
        envelope.jobId !== jobId ||
        envelope.sourceScriptHash !==
          checkpoint.scriptHash ||
        envelope.generationFingerprint !==
          checkpoint.generationFingerprint
      ) {
        throw new Error(
          "Native M3 envelope identity mismatch",
        );
      }

      // 5. Extract ONLY authoritative M3 timings.
      const timings = validateNativeM3Timings(
        verified.shotIds,
        options.extractTimings(
          verified.package,
        ),
      );

      return {
        jobId,
        packageHash: verified.packageHash,
        mode: (verified.package.mediaPlan as any)?.mode ?? "B",
        shotIds: [...verified.shotIds],
        timings,
      };
    },
  };
}
