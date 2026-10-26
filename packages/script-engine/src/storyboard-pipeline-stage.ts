import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";

import {
  inputHash,
  type PipelineContext,
  type PipelineStage,
} from "@youcreator/core";

import {
  VideoScriptSchema,
  resolveCanonicalVisualMode,
  type Storyboard,
  type VideoScript,
} from "@youcreator/contracts";

import {
  hashScriptContent,
} from "./script-job-artifacts.js";

import {
  planVisualContinuity,
  VisualIdentityConfigSchema,
  type VisualIdentityConfig,
  type VisualContinuityProfile,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
  type VideoMediaMode,
} from "./scene-media-plan.js";

import {
  createStoryboardProductionPackage,
} from "./storyboard-production-package.js";

import {
  getStoryboardArtifactPath,
  loadStoryboardJobArtifact,
  saveStoryboardJobArtifact,
} from "./storyboard-job-artifacts.js";

import {
  withStoryboardGenerationLock,
} from "./storyboard-generation-lock.js";

import {
  createStoryboardGenerationKey,
  type StoryboardGenerationConfig,
} from "./storyboard-generation-identity.js";

export const StoryboardStageOutputSchema = z.object({
  artifactPath: z.string().min(1),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  scriptHash: z.string().regex(/^[a-f0-9]{64}$/),
  generationFingerprint:
    z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type StoryboardStageOutput = z.infer<
  typeof StoryboardStageOutputSchema
>;

export interface StoryboardPlanningPort {
  plan(script: VideoScript): Promise<Storyboard>;
}

interface StoryboardPipelineBaseOptions {
  planner: StoryboardPlanningPort;

  // Must load the verified final script, not the
  // original unpromoted script.
  loadFinalScript(
    context: PipelineContext,
  ): Promise<VideoScript>;

  mode: VideoMediaMode;
  profile: VisualContinuityProfile;
  identityConfig?: VisualIdentityConfig;
  mediaPlanVersion?: 1 | 2;
}

export type StoryboardPipelineOptions =
  StoryboardPipelineBaseOptions &
    (
      | {
          plannerGenerationConfig:
            StoryboardGenerationConfig;
          plannerGenerationKey?: never;
        }
      | {
          plannerGenerationKey: string;
          plannerGenerationConfig?: never;
        }
    );

async function fileExists(
  filename: string,
): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export function createStoryboardPipelineStage(
  options: StoryboardPipelineOptions,
): PipelineStage<StoryboardStageOutput> {
  const plannerGenerationKey =
    options.plannerGenerationConfig !== undefined
      ? createStoryboardGenerationKey(
          options.plannerGenerationConfig,
        )
      : options.plannerGenerationKey;

  if (!plannerGenerationKey?.trim()) {
    throw new Error(
      "Storyboard planner generation identity is required",
    );
  }

  if (
    options.plannerGenerationConfig !== undefined &&
    options.plannerGenerationConfig.segmentation.profile !==
      options.profile
  ) {
    throw new Error(
      "Storyboard profile does not match planner configuration",
    );
  }

  const identityConfig = VisualIdentityConfigSchema.parse(
    options.identityConfig ?? {},
  );

  const configuration = {
    stageVersion: 1,
    plannerGenerationKey,
    mode: options.mode,
    profile: options.profile,
    identityConfig,
    mediaPlanningVersion: options.mediaPlanVersion ?? 1,
    mediaQAVersion: 1,
    productionPackageVersion: 1,
  };

  const configurationHash = inputHash(configuration);

  async function getSource(
    context: PipelineContext,
  ) {
    if (!context.outputs.has("script")) {
      throw new Error(
        "Storyboard requires a completed script stage",
      );
    }

    const script = VideoScriptSchema.parse(
      await options.loadFinalScript(context),
    );

    const scriptHash = hashScriptContent(script);

    const candidateProfile =
      (context.job.config as any)?.profileId ??
      (context.job.config as any)?.profile ??
      options.profile;

    const isV2 =
      context.job.config?.version === 2 ||
      context.job.config?.mode === "stock" ||
      context.job.config?.mode === "ai" ||
      context.job.config?.mode === "manual" ||
      options.mediaPlanVersion === 2;

    const resolvedMode = isV2 && context.job.config?.mode
      ? resolveCanonicalVisualMode({
          version: 2,
          mode: context.job.config.mode,
        })
      : null;

    const activeMode = resolvedMode
      ? resolvedMode.canonicalMode
      : ((context.job.config?.mode as VideoMediaMode | undefined) ?? options.mode);

    const activePlanVersion = isV2 ? 2 : (options.mediaPlanVersion ?? 1);

    const activeConfigHash = inputHash({
      stageVersion: 1,
      plannerGenerationKey,
      mode: activeMode,
      profile: candidateProfile,
      identityConfig,
      mediaPlanningVersion: activePlanVersion,
      mediaQAVersion: 1,
      productionPackageVersion: 1,
    });

    const generationFingerprint = inputHash({
      configurationHash: activeConfigHash,
      scriptHash,
    });

    return {
      script,
      scriptHash,
      generationFingerprint,
      activeMode,
      activeProfile: candidateProfile,
      activePlanVersion,
    };
  }

  async function loadExisting(
    context: PipelineContext,
    source: Awaited<ReturnType<typeof getSource>>,
  ) {
    const jobsRoot = path.dirname(
      context.jobDirectory,
    );

    return loadStoryboardJobArtifact({
      jobsRoot,
      jobId: context.job.id,
      expectedGenerationFingerprint:
        source.generationFingerprint,
      expectedScriptHash: source.scriptHash,
    });
  }

  function toOutput(
    context: PipelineContext,
    source: Awaited<ReturnType<typeof getSource>>,
    packageHash: string,
  ): StoryboardStageOutput {
    return {
      artifactPath: getStoryboardArtifactPath(
        path.dirname(context.jobDirectory),
        context.job.id,
      ),
      packageHash,
      scriptHash: source.scriptHash,
      generationFingerprint:
        source.generationFingerprint,
    };
  }

  return {
    id: "storyboard",
    version: `m3-10b:${configurationHash}`,
    dependencies: ["script"],
    outputSchema: StoryboardStageOutputSchema,

    async execute(context) {
      const jobsRoot = path.dirname(
        context.jobDirectory,
      );

      return withStoryboardGenerationLock(
        jobsRoot,
        context.job.id,
        async () => {
          const source = await getSource(context);

          const filename = getStoryboardArtifactPath(
            path.dirname(context.jobDirectory),
            context.job.id,
          );

          // Recovery first: no LLM request if valid
          // production bytes already exist.
          if (await fileExists(filename)) {
            const stored = await loadExisting(
              context,
              source,
            );

            return toOutput(
              context,
              source,
              stored.package.packageHash,
            );
          }

          const storyboard = await options.planner.plan(
            source.script,
          );

          const continuity = planVisualContinuity(
            storyboard,
            source.activeProfile,
            identityConfig,
          );

          const mediaPlan = createSceneMediaPlan(
            storyboard,
            continuity,
            source.activeMode,
            source.activePlanVersion,
          );

          const productionPackage =
            createStoryboardProductionPackage({
              script: source.script,
              storyboard,
              continuity,
              mediaPlan,
            });

          // Create-only publication prevents silent
          // replacement of a previous result.
          await saveStoryboardJobArtifact({
            jobsRoot: path.dirname(
              context.jobDirectory,
            ),
            jobId: context.job.id,
            generationFingerprint:
              source.generationFingerprint,
            package: productionPackage,
          });

          // Read back and fully verify persisted bytes.
          const stored = await loadExisting(
            context,
            source,
          );

          return toOutput(
            context,
            source,
            stored.package.packageHash,
          );
        },
      );
    },

    async validateOutput(output, context) {
      const source = await getSource(context);

      const expectedPath = getStoryboardArtifactPath(
        path.dirname(context.jobDirectory),
        context.job.id,
      );

      if (
        output.artifactPath !== expectedPath ||
        output.scriptHash !== source.scriptHash ||
        output.generationFingerprint !==
          source.generationFingerprint
      ) {
        return false;
      }

      // A missing file invalidates a checkpoint.
      // A corrupt existing file must fail safely.
      if (!(await fileExists(expectedPath))) {
        return false;
      }

      const stored = await loadExisting(
        context,
        source,
      );

      return (
        stored.package.packageHash ===
        output.packageHash
      );
    },
  };
}
