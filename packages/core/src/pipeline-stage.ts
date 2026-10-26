import type { z } from "zod";

import type {
  PipelineStageId,
  VideoJob,
} from "@youcreator/contracts";

export interface PipelineContext {
  job: VideoJob;
  jobDirectory: string;
  outputs: ReadonlyMap<PipelineStageId, unknown>;
}

export interface PipelineStage<TOutput = unknown> {
  id: PipelineStageId;
  version: string;
  dependencies: PipelineStageId[];

  outputSchema?: z.ZodType<TOutput>;

  execute(context: PipelineContext): Promise<TOutput>;

  validateOutput?(
    output: TOutput,
    context: PipelineContext,
  ): Promise<boolean>;
}