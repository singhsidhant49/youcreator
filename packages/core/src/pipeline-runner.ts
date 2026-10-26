import type {
  PipelineStageId,
  PipelineStageRun,
  VideoJob,
} from "@youcreator/contracts";

import { PipelineRegistry } from "./pipeline-registry.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { inputHash } from "./input-hash.js";

export interface PipelineExecutionResult {
  jobId: string;
  status: "completed" | "failed";
  stageRuns: PipelineStageRun[];
  outputs: ReadonlyMap<PipelineStageId, unknown>;
}

export interface PipelineRunOptions {
  checkCancelled?: () => Promise<boolean> | boolean;
  onStageStart?: (stageId: PipelineStageId) => void;
  onStageComplete?: (run: PipelineStageRun) => void;
}

export class PipelineRunner {
  constructor(
    private readonly registry: PipelineRegistry,
  ) {}

  async run(
    job: VideoJob,
    jobDirectory: string,
    options?: PipelineRunOptions,
  ): Promise<PipelineExecutionResult> {
    const stages = this.registry.resolveOrder();

    const outputs = new Map<PipelineStageId, unknown>();
    const stageRuns: PipelineStageRun[] = [];
    const checkpoints = new CheckpointStore(jobDirectory);

    for (const stage of stages) {
      if (options?.checkCancelled && (await options.checkCancelled())) {
        throw new Error("Pipeline execution cancelled by user");
      }

      options?.onStageStart?.(stage.id);
      const startedAt = new Date().toISOString();
      let hash: string | undefined;

      try {
        hash = inputHash({
          stageId: stage.id,
          stageVersion: stage.version,
          config: job.config,
          dependencies: Object.fromEntries(
            stage.dependencies.map((id) => [
              id,
              outputs.get(id),
            ]),
          ),
        });

        const existing = await checkpoints.load(stage.id);

        if (existing && existing.inputHash === hash) {
          const parsed = stage.outputSchema
            ? stage.outputSchema.safeParse(existing.output)
            : { success: true as const, data: existing.output };

          if (parsed.success) {
            const context = {
              job,
              jobDirectory,
              outputs: new Map(outputs),
            };

            const valid = stage.validateOutput
              ? await stage.validateOutput(parsed.data, context)
              : true;

            if (valid) {
              outputs.set(stage.id, parsed.data);

              const skippedRun: PipelineStageRun = {
                stageId: stage.id,
                status: "skipped",
                inputHash: hash,
                completedAt: existing.completedAt,
              };
              stageRuns.push(skippedRun);
              options?.onStageComplete?.(skippedRun);

              continue;
            }
          }
        }

        const rawOutput = await stage.execute({
          job,
          jobDirectory,
          outputs: new Map(outputs),
        });

        const output = stage.outputSchema
          ? stage.outputSchema.parse(rawOutput)
          : rawOutput;

        if (stage.validateOutput) {
          const valid = await stage.validateOutput(
            output,
            {
              job,
              jobDirectory,
              outputs: new Map(outputs),
            },
          );

          if (!valid) {
            throw new Error(
              `Stage ${stage.id} produced invalid output`,
            );
          }
        }

        outputs.set(stage.id, output);
        await checkpoints.save(stage.id, output, hash);

        const completedRun: PipelineStageRun = {
          stageId: stage.id,
          status: "completed",
          inputHash: hash,
          startedAt,
          completedAt: new Date().toISOString(),
        };
        stageRuns.push(completedRun);
        options?.onStageComplete?.(completedRun);
      } catch (error) {
        stageRuns.push({
          stageId: stage.id,
          status: "failed",
          inputHash: hash,
          startedAt,
          completedAt: new Date().toISOString(),
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });

        return {
          jobId: job.id,
          status: "failed",
          stageRuns,
          outputs,
        };
      }
    }

    return {
      jobId: job.id,
      status: "completed",
      stageRuns,
      outputs,
    };
  }
}