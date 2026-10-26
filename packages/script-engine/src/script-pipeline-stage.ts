import path from "node:path";

import type {
  PipelineContext,
  PipelineStage,
} from "@youcreator/core";

import {
  ScriptGenerationStage,
  generationFingerprint,
  type ScriptStageGenerator,
} from "./script-generation-stage.js";

import {
  ScriptStageOutputSchema,
  validateScriptStageOutput,
  type ValidatedScriptStageOutput,
} from "./script-stage-output.js";

import {
  loadScriptJobArtifacts,
} from "./script-job-artifacts.js";

import {
  evaluateFinalScriptReadiness,
  type FinalScriptReadinessOptions,
} from "./final-script-readiness.js";

import {
  createScriptGenerationKey,
  type ScriptGenerationIdentityConfig,
} from "./script-generation-identity.js";

import type {
  EditorialNarrativePlan,
} from "./editorial-narrative-plan.js";

interface ScriptPipelineBaseOptions {
  readiness?: {
    enabled: boolean;
    policy?: Omit<
      FinalScriptReadinessOptions,
      "targetDurationSeconds"
    >;
  };
  narrativePlan?: EditorialNarrativePlan;
}

export type ScriptPipelineOptions =
  ScriptPipelineBaseOptions &
    (
      | {
          generationConfig: ScriptGenerationIdentityConfig;
          generationKey?: never;
        }
      | {
          generationKey: string;
          generationConfig?: never;
        }
    );

function getBrief(context: PipelineContext) {
  const candidateProfile =
    (context.job.config as any)?.profileId ??
    (context.job.config as any)?.profile ??
    (context.job as any)?.payload?.profileId ??
    (context.job as any)?.payload?.profile;

  const profile =
    candidateProfile === "explainer" ||
    candidateProfile === "documentary" ||
    candidateProfile === "story"
      ? candidateProfile
      : undefined;

  const topic =
    (context.job.config as any)?.prompt ??
    (context.job.config as any)?.topic ??
    context.job.config.title;

  return {
    topic,
    durationSeconds: context.job.config.durationSeconds,
    ...(profile ? { profile } : {}),
  };
}

export function createScriptPipelineStage(
  generator: ScriptStageGenerator,
  options: ScriptPipelineOptions,
): PipelineStage<ValidatedScriptStageOutput> {
  const baseGenerationKey =
    options.generationConfig !== undefined
      ? createScriptGenerationKey(
          options.narrativePlan
            ? {
                ...options.generationConfig,
                narrativePlan: {
                  version: options.narrativePlan.version,
                  planHash: options.narrativePlan.planHash,
                  profile: options.narrativePlan.profile,
                },
              }
            : options.generationConfig,
        )
      : options.narrativePlan
        ? `${options.generationKey}:narrative-v${options.narrativePlan.version}:${options.narrativePlan.planHash}`
        : options.generationKey;

  if (
    typeof baseGenerationKey !== "string" ||
    !baseGenerationKey.trim()
  ) {
    throw new Error(
      "Script generation configuration or key is required",
    );
  }

  const handler = new ScriptGenerationStage(generator);

  const readinessEnabled =
    options.readiness?.enabled === true;

  const readinessPolicy =
    options.readiness?.policy ?? {};

  // Readiness settings affect stage behavior, so they
  // must be part of its checkpoint/recovery identity.
  const effectiveGenerationKey = readinessEnabled
    ? JSON.stringify({
        generationKey: baseGenerationKey,
        readinessVersion: 1,
        readinessPolicy,
      })
    : baseGenerationKey;

  function evaluateReadiness(
    script: Awaited<
      ReturnType<typeof loadScriptJobArtifacts>
    >["finalScript"],
    targetDurationSeconds: number,
  ) {
    return evaluateFinalScriptReadiness(script, {
      ...readinessPolicy,
      targetDurationSeconds,
    });
  }

  return {
    id: "script",

    // Include the configuration identity so changing
    // it invalidates the runner's checkpoint hash.
    version: `18H:${effectiveGenerationKey}`,

    dependencies: [],

    outputSchema: ScriptStageOutputSchema,

    async execute(context) {
      const baseBrief = getBrief(context);
      const brief = {
        ...baseBrief,
        ...(options.narrativePlan ? { narrativePlan: options.narrativePlan } : {}),
      };

      const output = await handler.execute({
        jobId: context.job.id,
        jobsRoot: path.dirname(
          path.resolve(context.jobDirectory),
        ),
        brief,
        generationKey: effectiveGenerationKey,
      });

      if (readinessEnabled) {
        const stored = await loadScriptJobArtifacts(
          path.resolve(context.jobDirectory),
          "script",
        );

        const readiness = evaluateReadiness(
          stored.finalScript,
          brief.durationSeconds,
        );

        if (!readiness.ready) {
          throw new Error(
            `Final script readiness failed: ${
              readiness.blockers.join("; ")
            }`,
          );
        }
      }

      return output;
    },

    async validateOutput(output, context) {
      try {
        const expectedDirectory = path.join(
          path.resolve(context.jobDirectory),
          "script",
        );

        // Check that the checkpoint references the
        // current job, not a different job's artifacts.
        if (
          output.jobId !== context.job.id ||
          path.resolve(output.artifactDirectory) !==
            expectedDirectory
        ) {
          return false;
        }

        await validateScriptStageOutput(output);

        const stored = await loadScriptJobArtifacts(
          path.resolve(context.jobDirectory),
          "script",
        );

        if (!stored.integrityVerified) {
          return false;
        }

        const expectedFingerprint =
          generationFingerprint(
            getBrief(context),
            effectiveGenerationKey,
          );

        if (
          stored.generationFingerprint !==
          expectedFingerprint
        ) {
          return false;
        }

        if (readinessEnabled) {
          const readiness = evaluateReadiness(
            stored.finalScript,
            getBrief(context).durationSeconds,
          );

          if (!readiness.ready) {
            return false;
          }
        }

        return true;
      } catch {
        // Invalid checkpoint output cannot be reused.
        // The runner will attempt stage execution,
        // where recovery rules decide whether it
        // is safe to continue or must fail.
        return false;
      }
    },
  };
}
