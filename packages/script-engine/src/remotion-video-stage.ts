import {
  type PersistentRemotionVideoStore,
  type RemotionVideoCheckpoint,
  RemotionVideoCheckpointSchema,
} from "./persistent-remotion-video.js";

export const REMOTION_VIDEO_STAGE_ID =
  "video" as const;

export interface NativeRemotionVideoStage {
  readonly id: typeof REMOTION_VIDEO_STAGE_ID;

  execute(jobId: string): Promise<{
    stageId: typeof REMOTION_VIDEO_STAGE_ID;
    jobId: string;
    reused: boolean;
    checkpoint: RemotionVideoCheckpoint;
  }>;

  validate(
    jobId: string,
    checkpoint: unknown,
  ): Promise<boolean>;
}

export function createNativeRemotionVideoStage(
  store: PersistentRemotionVideoStore,
): NativeRemotionVideoStage {
  return {
    id: REMOTION_VIDEO_STAGE_ID,

    async execute(jobId) {
      if (!jobId.trim()) {
        throw new Error(
          "M7 video stage requires job ID",
        );
      }

      const result = await store.run(jobId);

      const valid = await store.validate(
        jobId,
        result.checkpoint,
      );

      if (!valid) {
        throw new Error(
          "M7 produced invalid video checkpoint",
        );
      }

      return {
        stageId: REMOTION_VIDEO_STAGE_ID,
        jobId,
        reused: result.reused,
        checkpoint: result.checkpoint,
      };
    },

    async validate(jobId, candidate) {
      const parsed =
        RemotionVideoCheckpointSchema.safeParse(
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
