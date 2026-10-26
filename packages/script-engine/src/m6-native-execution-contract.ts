import {
  AUDIO_ALIGNED_VISUAL_STAGE_ID,
} from "./audio-aligned-visual-stage.js";

import {
  AudioAlignedVisualCheckpointSchema,
  type AudioAlignedVisualCheckpoint,
} from "./persistent-audio-aligned-visual.js";

import {
  type M6JobExecutorBridge,
} from "./m6-job-executor-bridge.js";

export interface M6NativeExecutionContext {
  jobId: string;
}

export interface M6NativeExecutionResult {
  stageId: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID;
  checkpoint: AudioAlignedVisualCheckpoint;
}

export interface M6NativeExecutionContract {
  readonly stageId: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID;

  run(
    context: M6NativeExecutionContext,
  ): Promise<M6NativeExecutionResult>;

  validate(
    context: M6NativeExecutionContext,
    checkpoint: unknown,
  ): Promise<boolean>;
}

/**
 * Adapts verified M6 execution to an M1-compatible
 * run/validate boundary.
 *
 * Stage dependency ordering, durable checkpoint
 * storage and resume remain owned by M1.
 */
export function createM6NativeExecutionContract(
  bridge: M6JobExecutorBridge,
): M6NativeExecutionContract {
  if (
    bridge.id !== AUDIO_ALIGNED_VISUAL_STAGE_ID
  ) {
    throw new Error(
      "M6 native execution stage mismatch",
    );
  }

  return {
    stageId: AUDIO_ALIGNED_VISUAL_STAGE_ID,

    async run(context) {
      if (!context.jobId.trim()) {
        throw new Error(
          "M6 native execution requires job ID",
        );
      }

      const result = await bridge.execute({
        jobId: context.jobId,
      });

      if (
        result.stageId !==
          AUDIO_ALIGNED_VISUAL_STAGE_ID
      ) {
        throw new Error(
          "M6 native execution result stage mismatch",
        );
      }

      const checkpoint =
        AudioAlignedVisualCheckpointSchema.parse(
          result.checkpoint,
        );

      if (
        checkpoint.jobId !== context.jobId
      ) {
        throw new Error(
          "M6 native execution checkpoint mismatch",
        );
      }

      return {
        stageId: AUDIO_ALIGNED_VISUAL_STAGE_ID,
        checkpoint,
      };
    },

    async validate(context, candidate) {
      if (!context.jobId.trim()) {
        return false;
      }

      const parsed =
        AudioAlignedVisualCheckpointSchema.safeParse(
          candidate,
        );

      if (
        !parsed.success ||
        parsed.data.jobId !== context.jobId
      ) {
        return false;
      }

      try {
        return await bridge.validate(
          { jobId: context.jobId },
          parsed.data,
        );
      } catch {
        return false;
      }
    },
  };
}
