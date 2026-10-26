import {
  AudioAlignedVisualCheckpointSchema,
  type AudioAlignedVisualCheckpoint,
  type PersistentAudioAlignedVisualStore,
} from "./persistent-audio-aligned-visual.js";

export const AUDIO_ALIGNED_VISUAL_STAGE_ID =
  "audio_aligned_visual" as const;

export interface AudioAlignedVisualStageResult {
  stageId: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID;
  jobId: string;
  reused: boolean;
  checkpoint: AudioAlignedVisualCheckpoint;
}

export interface NativeAudioAlignedVisualStage {
  readonly id: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID;

  execute(
    jobId: string,
  ): Promise<AudioAlignedVisualStageResult>;

  validate(
    jobId: string,
    checkpoint: unknown,
  ): Promise<boolean>;
}

export function createNativeAudioAlignedVisualStage(
  store: PersistentAudioAlignedVisualStore,
): NativeAudioAlignedVisualStage {
  return {
    id: AUDIO_ALIGNED_VISUAL_STAGE_ID,

    async execute(jobId) {
      if (!jobId.trim()) {
        throw new Error(
          "Audio-aligned visual stage requires job ID",
        );
      }

      const result = await store.run(jobId);

      return {
        stageId: AUDIO_ALIGNED_VISUAL_STAGE_ID,
        jobId,
        reused: result.reused,
        checkpoint: result.checkpoint,
      };
    },

    async validate(jobId, checkpoint) {
      if (!jobId.trim()) {
        return false;
      }

      const parsed =
        AudioAlignedVisualCheckpointSchema.safeParse(
          checkpoint,
        );

      if (
        !parsed.success ||
        parsed.data.jobId !== jobId
      ) {
        return false;
      }

      try {
        return await store.validate(
          jobId,
          parsed.data,
        );
      } catch {
        return false;
      }
    },
  };
}
