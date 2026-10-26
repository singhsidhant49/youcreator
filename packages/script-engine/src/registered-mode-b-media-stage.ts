import { readFile } from "node:fs/promises";

import {
  type PipelineContext,
  type PipelineRegistry,
  type PipelineStage,
} from "@youcreator/core";

import {
  resolveCanonicalVisualMode,
} from "@youcreator/contracts";

import {
  StoryboardStageOutputSchema,
} from "./storyboard-pipeline-stage.js";

import {
  StoryboardArtifactEnvelopeSchema,
} from "./storyboard-job-artifacts.js";

import {
  createMediaPipelineStage,
  type MediaStageOutput,
} from "./media-pipeline-stage.js";

import {
  createAuthoritativeM3Adapter,
} from "./authoritative-m3-adapter.js";

import {
  loadVerifiedProductionPackage,
} from "./verified-production-package.js";

import {
  ModeBPersistentRunner,
} from "./mode-b-persistent-runner.js";

import {
  getMediaResolutionManifestPath,
  registerMediaPipelineStage,
} from "./media-pipeline-registration.js";

import type {
  MediaCandidateProvider,
} from "./media-resolver.js";

import type {
  AIImageProvider,
} from "./ai-image-generation.js";

import {
  type ShotMediaResolver,
  resolveModeCAssignments,
} from "./media-resolution-coordinator.js";

export interface RegisteredModeBMediaOptions {
  registry: PipelineRegistry;

  // Root of the shared M4 object store.
  storageRoot: string;

  // Canonical M1 job directory, independent
  // of media object storage.
  jobDirectory(jobId: string): string;

  providers?(
    context: { jobId: string },
  ): MediaCandidateProvider[];

  allowedLocalRoots(
    context: { jobId: string },
  ): string[];

  /**
   * Visual mode identity for the media stage.
   * "A" for Version 2 Intelligent Stock & Web (defaulting to "B" for historical jobs).
   */
  mode?: "A" | "B";

  version?: 1 | 2;

  aiProvider?(
    context: { jobId: string },
  ): AIImageProvider | undefined;

  aiResolver?(
    context: { jobId: string },
  ): ShotMediaResolver | undefined;

  targetAspectRatio?: number;
}

export function createRegisteredModeBMediaStage(
  options: RegisteredModeBMediaOptions,
): PipelineStage<MediaStageOutput> {
  const targetMode = options.mode ?? "B";
  const m3Adapter =
    createAuthoritativeM3Adapter();

  const runner = new ModeBPersistentRunner({
    storageRoot: options.storageRoot,

    jobDirectory: options.jobDirectory,

    m3Adapter,

    targetAspectRatio: options.targetAspectRatio,

    providers: options.providers
      ? (jobId) => options.providers!({ jobId })
      : undefined,

    aiProvider: options.aiProvider
      ? (jobId) => options.aiProvider!({ jobId })
      : undefined,

    aiResolver: options.aiResolver
      ? (jobId) => options.aiResolver!({ jobId })
      : undefined,

    allowedLocalRoots: (jobId) =>
      options.allowedLocalRoots({ jobId }),
  });

  async function verifyStoryboardBinding(
    context: PipelineContext,
  ) {
    const rawOutput =
      context.outputs.get("storyboard");

    if (!rawOutput) {
      throw new Error(
        "Media stage requires completed storyboard output",
      );
    }

    const storyboardOutput =
      StoryboardStageOutputSchema.parse(
        rawOutput,
      );

    function resolveJobMode(ctx: PipelineContext): "A" | "B" | "C" | "D" {
      const isV2Job =
        ctx.job.config?.version === 2 ||
        options.version === 2 ||
        ctx.job.config?.mode === "stock" ||
        ctx.job.config?.mode === "ai" ||
        ctx.job.config?.mode === "manual";

      if (isV2Job && ctx.job.config?.mode) {
        const resolved = resolveCanonicalVisualMode({
          version: 2,
          mode: ctx.job.config.mode,
        });
        return resolved.canonicalMode;
      }
      return (ctx.job.config?.mode as "A" | "B" | "C" | "D") ?? targetMode;
    }

    const effectiveMode = resolveJobMode(context);
    const verified =
      await loadVerifiedProductionPackage({
        jobId: context.job.id,
        jobDirectory: context.jobDirectory,
        expectedMode: effectiveMode === "C" ? undefined : effectiveMode,
        adapter: m3Adapter,
      });

    if (
      storyboardOutput.packageHash !==
        verified.packageHash ||
      storyboardOutput.artifactPath !==
        verified.artifactPath
    ) {
      throw new Error(
        "M3 storyboard checkpoint does not match production package",
      );
    }

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
      envelope.jobId !== context.job.id ||
      envelope.generationFingerprint !==
        storyboardOutput.generationFingerprint ||
      envelope.sourceScriptHash !==
        storyboardOutput.scriptHash
    ) {
      throw new Error(
        "M3 storyboard checkpoint identity mismatch",
      );
    }

    return verified;
  }

  const base = createMediaPipelineStage({
    contextAdapter: {
      getJobId(context: PipelineContext) {
        return context.job.id;
      },

      getJobDirectory(context: PipelineContext) {
        return context.jobDirectory;
      },

      getExpectedMode(context?: PipelineContext) {
        if (context) {
          const isV2Job =
            context.job.config?.version === 2 ||
            options.version === 2 ||
            context.job.config?.mode === "stock" ||
            context.job.config?.mode === "ai" ||
            context.job.config?.mode === "manual";

          if (isV2Job && context.job.config?.mode) {
            const resolved = resolveCanonicalVisualMode({
              version: 2,
              mode: context.job.config.mode,
            });
            return resolved.canonicalMode;
          }
          return (context.job.config?.mode as "A" | "B" | "C" | "D") ?? targetMode;
        }
        return targetMode;
      },

      buildRequest(context, verified) {
        const jobConfig = context?.job?.config;
        const rawMediaPlan = verified.package && typeof verified.package === "object" && "mediaPlan" in verified.package
          ? (verified.package as { mediaPlan?: { version?: number } }).mediaPlan
          : undefined;

        const isV2 =
          jobConfig?.version === 2 ||
          options.version === 2 ||
          jobConfig?.mode === "stock" ||
          jobConfig?.mode === "ai" ||
          jobConfig?.mode === "manual" ||
          (rawMediaPlan && rawMediaPlan.version === 2);

        const effectiveMode = isV2 && jobConfig?.mode
          ? resolveCanonicalVisualMode({
              version: 2,
              mode: jobConfig.mode,
            }).canonicalMode
          : (jobConfig?.mode as "A" | "B" | "C" | "D") ?? targetMode;

        if (effectiveMode === "A" && isV2) {
          return {
            version: 2 as const,
            jobId: verified.jobId,
            mode: "A" as const,
            shotIds: verified.shotIds,
          };
        }

        if (effectiveMode === "B" && isV2) {
          return {
            version: 2 as const,
            jobId: verified.jobId,
            mode: "B" as const,
            shotIds: verified.shotIds,
            allowPaidGeneration: true,
            provider: (jobConfig as any)?.imageProvider,
            model: (jobConfig as any)?.imageModel,
          };
        }

        if (effectiveMode === "C" && isV2) {
          return {
            version: 2 as const,
            jobId: verified.jobId,
            mode: "C" as const,
            shotIds: verified.shotIds,
            assignments: resolveModeCAssignments((jobConfig as any)?.assignments, verified.shotIds),
          };
        }

        return {
          jobId: verified.jobId,
          mode: "B" as const,
          shotIds: verified.shotIds,
        };
      },
    },

    m3Adapter,

    persistentStage: runner,

    manifestPath(jobId) {
      return getMediaResolutionManifestPath(
        options.storageRoot,
        jobId,
      );
    },
  });

  type ModeBMediaStage = PipelineStage<MediaStageOutput> & {
    readonly id: "media";
  };

  const stage: ModeBMediaStage = {
    ...base,

    id: "media",

    dependencies: [
      "storyboard",
    ],

    async execute(
      context: PipelineContext,
    ): Promise<MediaStageOutput> {
      await verifyStoryboardBinding(context);

      return base.execute(context);
    },

    async validateOutput(
      output: MediaStageOutput,
      context: PipelineContext,
    ): Promise<boolean> {
      try {
        await verifyStoryboardBinding(context);

        return await base.validateOutput(
          output,
          context,
        );
      } catch {
        return false;
      }
    },
  };

  registerMediaPipelineStage<ModeBMediaStage>({
    registry: options.registry,
    stage,
  });

  return stage;
}

/**
 * Alias for New Mode A Stock Media Stage.
 */
export const createRegisteredStockMediaStage = createRegisteredModeBMediaStage;
