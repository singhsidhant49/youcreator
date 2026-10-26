import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import {
  loadVerifiedProductionPackage,
  type VerifiedM3PackageAdapter,
  type VerifiedProductionPackageResult,
} from "./verified-production-package.js";

import {
  PersistentMediaInputSchema,
  type PersistentMediaInput,
  type PersistentMediaManifest,
  type PersistentMediaResolutionStage,
} from "./persistent-media-resolution.js";

import {
  MediaResolutionRequestSchema,
  type MediaResolutionRequest,
} from "./media-resolution-coordinator.js";

import {
  verifyMediaResolutionReport,
} from "./media-report-integrity.js";

const HashSchema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

export const MediaStageOutputSchema = z.object({
  version: z.literal(1),

  jobId: z.string().min(1),

  stageVersion: z.literal(
    "m4-media-pipeline-v1",
  ),

  mode: z.enum(["A", "B", "C", "D"]),

  packageHash: HashSchema,
  storyboardSha256: HashSchema,
  mediaPlanSha256: HashSchema,

  inputHash: HashSchema,
  manifestHash: HashSchema,

  shotCount: z.number().int().positive(),
  assignedCount: z.number().int().positive(),

  completedAt: z.string().datetime(),
}).strict();

export type MediaStageOutput = z.infer<
  typeof MediaStageOutputSchema
>;

export interface MediaPipelineStageContextAdapter<TContext> {
  getJobId(context: TContext): string;

  getJobDirectory(context: TContext): string;

  getExpectedMode(
    context: TContext,
  ): "A" | "B" | "C" | "D";

  /**
   * Build the mode-specific request from the verified
   * package and immutable job configuration.
   *
   * It must not take shot IDs from user input.
   */
  buildRequest<TPackage>(
    context: TContext,
    verified: VerifiedProductionPackageResult<TPackage>,
  ): MediaResolutionRequest;
}

export interface MediaPipelineStageOptions<
  TContext,
  TPackage,
> {
  contextAdapter:
    MediaPipelineStageContextAdapter<TContext>;

  m3Adapter: VerifiedM3PackageAdapter<TPackage>;

  persistentStage: Pick<
    PersistentMediaResolutionStage,
    "run"
  >;

  /**
   * Must return the actual manifest location used
   * by PersistentMediaResolutionStage.
   */
  manifestPath(jobId: string): string;
}

function sha256(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

async function readManifest(
  filename: string,
): Promise<{
  manifest: PersistentMediaManifest;
  hash: string;
}> {
  const raw = await readFile(filename, "utf8");

  const parsed = JSON.parse(raw) as
    PersistentMediaManifest;

  return {
    manifest: parsed,
    hash: sha256(JSON.stringify(parsed)),
  };
}

export function createMediaPipelineStage<
  TContext,
  TPackage,
>(
  options: MediaPipelineStageOptions<
    TContext,
    TPackage
  >,
) {
  async function loadInput(
    context: TContext,
  ): Promise<{
    input: PersistentMediaInput;
    verified:
      VerifiedProductionPackageResult<TPackage>;
  }> {
    const jobId =
      options.contextAdapter.getJobId(context);

    const verified =
      await loadVerifiedProductionPackage({
        jobDirectory:
          options.contextAdapter.getJobDirectory(
            context,
          ),
        jobId,
        expectedMode:
          options.contextAdapter.getExpectedMode(
            context,
          ),
        adapter: options.m3Adapter,
      });

    const request =
      MediaResolutionRequestSchema.parse(
        options.contextAdapter.buildRequest(
          context,
          verified,
        ),
      );

    // The verified M3 package is authoritative.
    if (
      request.jobId !== jobId ||
      request.mode !== verified.mode ||
      request.shotIds.length !==
        verified.shotIds.length ||
      request.shotIds.some(
        (id, index) =>
          id !== verified.shotIds[index],
      )
    ) {
      throw new Error(
        "M4 request does not match authoritative M3 package",
      );
    }

    const input =
      PersistentMediaInputSchema.parse({
        jobId,
        storyboardSha256:
          verified.storyboardSha256,
        mediaPlanSha256:
          verified.mediaPlanSha256,
        stageVersion: "m4-resolution-v1",
        request,
      });

    return { input, verified };
  }

  async function execute(
    context: TContext,
  ): Promise<MediaStageOutput> {
    const { input, verified } =
      await loadInput(context);

    const result =
      await options.persistentStage.run(input);

    verifyMediaResolutionReport(
      input.request,
      result.manifest.report,
    );

    if (!result.manifest.report.passed) {
      throw new Error(
        "M4 media resolution did not pass QA",
      );
    }

    const saved = await readManifest(
      options.manifestPath(input.jobId),
    );

    if (
      saved.manifest.inputHash !==
        result.manifest.inputHash ||
      saved.manifest.jobId !== input.jobId
    ) {
      throw new Error(
        "Persisted M4 manifest identity mismatch",
      );
    }

    const report = result.manifest.report;

    return MediaStageOutputSchema.parse({
      version: 1,
      jobId: input.jobId,
      stageVersion:
        "m4-media-pipeline-v1",
      mode: verified.mode,

      packageHash: verified.packageHash,
      storyboardSha256:
        verified.storyboardSha256,
      mediaPlanSha256:
        verified.mediaPlanSha256,

      inputHash:
        result.manifest.inputHash,
      manifestHash: saved.hash,

      shotCount: verified.shotIds.length,
      assignedCount:
        report.assignedShots,

      completedAt:
        result.manifest.completedAt,
    });
  }

  async function validateOutput(
    rawOutput: MediaStageOutput,
    context: TContext,
  ): Promise<boolean> {
    try {
      const output =
        MediaStageOutputSchema.parse(
          rawOutput,
        );

      const { input, verified } =
        await loadInput(context);

      if (
        output.jobId !== input.jobId ||
        output.mode !== verified.mode ||
        output.packageHash !==
          verified.packageHash ||
        output.storyboardSha256 !==
          verified.storyboardSha256 ||
        output.mediaPlanSha256 !==
          verified.mediaPlanSha256 ||
        output.shotCount !==
          verified.shotIds.length
      ) {
        return false;
      }

      // Read the saved manifest BEFORE calling run().
      // Checkpoint validation must not start a new
      // media resolution operation.
      const saved = await readManifest(
        options.manifestPath(input.jobId),
      );

      if (
        saved.hash !== output.manifestHash ||
        saved.manifest.inputHash !==
          output.inputHash ||
        saved.manifest.jobId !==
          input.jobId ||
        saved.manifest.storyboardSha256 !==
          verified.storyboardSha256 ||
        saved.manifest.mediaPlanSha256 !==
          verified.mediaPlanSha256
      ) {
        return false;
      }

      verifyMediaResolutionReport(
        input.request,
        saved.manifest.report,
      );

      if (
        !saved.manifest.report.passed ||
        saved.manifest.report.assignedShots !==
          output.assignedCount
      ) {
        return false;
      }

      // PersistentMediaResolutionStage.run() will
      // reuse the existing completed manifest,
      // reverifying stored bytes and usage rights.
      const recovered =
        await options.persistentStage.run(input);

      if (!recovered.reused) {
        // Validation must NEVER initiate resolution.
        throw new Error(
          "Checkpoint verification unexpectedly executed media resolution",
        );
      }

      return true;
    } catch {
      return false;
    }
  }

  return {
    id: "media" as const,
    version: "m4-media-pipeline-v1",
    dependencies: ["storyboard"] as const,
    outputSchema: MediaStageOutputSchema,
    execute,
    validateOutput,
  };
}
