import { readFile } from "node:fs/promises";
import { z } from "zod";

import type {
  PipelineContext,
  PipelineStage,
} from "@youcreator/core";

import {
  PersistentVisualPackageStore,
  getPersistedVisualPath,
  verifyPersistedVisualRecord,
} from "./persistent-visual-package.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const VisualStageOutputSchema = z.object({
  version: z.literal(1),

  jobId: z.string().min(1),

  artifactPath: z.string().min(1),

  packageHash: HashSchema,
  visualPackageHash: HashSchema,

  productionPackageHash: HashSchema,
  mediaManifestHash: HashSchema,

  totalFrames: z.number().int().positive(),
  shotCount: z.number().int().positive(),
}).strict();

export type VisualStageOutput = z.infer<
  typeof VisualStageOutputSchema
>;

export interface VisualPipelineStageOptions {
  store: PersistentVisualPackageStore;

  /**
   * Canonical M1 job root.
   */
  jobDirectory(jobId: string): string;
}

export function createVisualPipelineStage(
  options: VisualPipelineStageOptions,
): PipelineStage<VisualStageOutput> {
  function verifyContext(
    context: PipelineContext,
  ): string {
    const jobId = context.job.id;

    if (
      options.jobDirectory(jobId) !==
      context.jobDirectory
    ) {
      throw new Error(
        "Visual stage canonical job directory mismatch",
      );
    }

    if (!context.outputs.has("media")) {
      throw new Error(
        "Visual stage requires completed media output",
      );
    }

    return jobId;
  }

  return {
    id: "visual",
    version: "m5-visual-pipeline-v1",
    dependencies: ["media"],

    outputSchema: VisualStageOutputSchema,

    async execute(
      context: PipelineContext,
    ): Promise<VisualStageOutput> {
      const jobId = verifyContext(context);

      const result = await options.store.run(
        jobId,
      );

      const visual = result.record.visual;

      return VisualStageOutputSchema.parse({
        version: 1,

        jobId,

        artifactPath: result.artifactPath,

        packageHash:
          result.record.packageHash,

        visualPackageHash:
          visual.visualPackageHash,

        productionPackageHash:
          visual.productionPackageHash,

        mediaManifestHash:
          visual.mediaManifestHash,

        totalFrames: visual.totalFrames,
        shotCount: visual.shotCount,
      });
    },

    async validateOutput(
      output: VisualStageOutput,
      context: PipelineContext,
    ): Promise<boolean> {
      try {
        const jobId = verifyContext(context);

        const parsed =
          VisualStageOutputSchema.parse(
            output,
          );

        if (parsed.jobId !== jobId) {
          return false;
        }

        const currentPath = getPersistedVisualPath(
          context.jobDirectory,
          jobId,
        );

        if (
          parsed.artifactPath !==
          currentPath
        ) {
          return false;
        }

        const valid = await options.store.validate(
          jobId,
          parsed.packageHash,
        );

        if (!valid) {
          return false;
        }

        const saved = verifyPersistedVisualRecord(
          JSON.parse(
            await readFile(currentPath, "utf8"),
          ),
          jobId,
        );

        return (
          parsed.packageHash === saved.packageHash &&
          parsed.visualPackageHash ===
            saved.visual.visualPackageHash &&
          parsed.productionPackageHash ===
            saved.visual.productionPackageHash &&
          parsed.mediaManifestHash ===
            saved.visual.mediaManifestHash &&
          parsed.totalFrames ===
            saved.visual.totalFrames &&
          parsed.shotCount ===
            saved.visual.shotCount
        );
      } catch {
        return false;
      }
    },
  };
}
