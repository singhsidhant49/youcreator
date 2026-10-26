import {
  AUDIO_ALIGNED_VISUAL_STAGE_ID,
  type NativeAudioAlignedVisualStage,
  type AudioAlignedVisualStageResult,
} from "./audio-aligned-visual-stage.js";

import {
  AudioAlignedVisualCheckpointSchema,
  type AudioAlignedVisualCheckpoint,
} from "./persistent-audio-aligned-visual.js";

export interface M6JobExecutorContext {
  jobId: string;
}

export interface M6StageExecution {
  stageId: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID;
  checkpoint: AudioAlignedVisualCheckpoint;
  reused: boolean;
}

export interface M6JobExecutorBridge {
  readonly id: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID;

  execute(
    context: M6JobExecutorContext,
  ): Promise<M6StageExecution>;

  validate(
    context: M6JobExecutorContext,
    checkpoint: unknown,
  ): Promise<boolean>;
}

export function createM6JobExecutorBridge(
  stage: NativeAudioAlignedVisualStage,
): M6JobExecutorBridge {
  if (stage.id !== AUDIO_ALIGNED_VISUAL_STAGE_ID) {
    throw new Error(
      "M6 JobExecutor stage ID mismatch",
    );
  }

  return {
    id: AUDIO_ALIGNED_VISUAL_STAGE_ID,

    async execute(context) {
      if (!context.jobId.trim()) {
        throw new Error(
          "M6 JobExecutor requires job ID",
        );
      }

      const result: AudioAlignedVisualStageResult =
        await stage.execute(context.jobId);

      if (
        result.stageId !== AUDIO_ALIGNED_VISUAL_STAGE_ID ||
        result.jobId !== context.jobId
      ) {
        throw new Error(
          "M6 JobExecutor execution identity mismatch",
        );
      }

      const checkpoint =
        AudioAlignedVisualCheckpointSchema.parse(
          result.checkpoint,
        );

      if (checkpoint.jobId !== context.jobId) {
        throw new Error(
          "M6 JobExecutor checkpoint job mismatch",
        );
      }

      // A successful execute() must yield an artifact
      // that passes current authoritative validation.
      const valid = await stage.validate(
        context.jobId,
        checkpoint,
      );

      if (!valid) {
        throw new Error(
          "M6 JobExecutor produced invalid checkpoint",
        );
      }

      return {
        stageId: AUDIO_ALIGNED_VISUAL_STAGE_ID,
        checkpoint,
        reused: result.reused,
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
        return await stage.validate(
          context.jobId,
          parsed.data,
        );
      } catch {
        return false;
      }
    },
  };
}
