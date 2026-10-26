import {
  type PersistentVideoQaStore,
  type VideoQaCheckpoint,
  VideoQaCheckpointSchema,
} from "./persistent-video-qa.js";

export const VIDEO_QA_STAGE_ID =
  "quality_assurance" as const;

export interface NativeVideoQaStage {
  readonly id: typeof VIDEO_QA_STAGE_ID;

  execute(jobId: string): Promise<{
    stageId: typeof VIDEO_QA_STAGE_ID;
    jobId: string;
    reused: boolean;
    checkpoint: VideoQaCheckpoint;
  }>;

  validate(
    jobId: string,
    checkpoint: unknown,
  ): Promise<boolean>;
}

export function createNativeVideoQaStage(
  store: PersistentVideoQaStore,
): NativeVideoQaStage {
  return {
    id: VIDEO_QA_STAGE_ID,

    async execute(jobId) {
      if (!jobId.trim()) {
        throw new Error(
          "M8 QA stage requires job ID",
        );
      }

      const result = await store.run(jobId);

      const valid = await store.validate(
        jobId,
        result.checkpoint,
      );

      if (!valid) {
        throw new Error(
          "M8 QA checkpoint failed verification",
        );
      }

      return {
        stageId: VIDEO_QA_STAGE_ID,
        jobId,
        reused: result.reused,
        checkpoint: result.checkpoint,
      };
    },

    async validate(jobId, candidate) {
      const parsed =
        VideoQaCheckpointSchema.safeParse(
          candidate,
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
