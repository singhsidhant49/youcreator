import { z } from "zod";

import {
  type PersistentVideoExportStore,
} from "./persistent-video-export.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const VIDEO_EXPORT_STAGE_ID =
  "video_export" as const;

export const VideoExportCheckpointSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  releaseHash: Hash,
  exportHash: Hash,
  videoSha256: Hash,
  qaReportHash: Hash,
}).strict();

export type VideoExportCheckpoint = z.infer<
  typeof VideoExportCheckpointSchema
>;

export interface NativeVideoExportStage {
  readonly id: typeof VIDEO_EXPORT_STAGE_ID;

  execute(jobId: string): Promise<{
    stageId: typeof VIDEO_EXPORT_STAGE_ID;
    jobId: string;
    reused: boolean;
    checkpoint: VideoExportCheckpoint;
  }>;

  validate(
    jobId: string,
    candidate: unknown,
  ): Promise<boolean>;
}

export function createNativeVideoExportStage(
  store: PersistentVideoExportStore,
): NativeVideoExportStage {
  return {
    id: VIDEO_EXPORT_STAGE_ID,

    async execute(jobId) {
      if (!jobId.trim()) {
        throw new Error(
          "M9 video export requires job ID",
        );
      }

      const result = await store.run(jobId);

      const checkpoint =
        VideoExportCheckpointSchema.parse({
          version: 1,
          jobId,
          releaseHash:
            result.manifest.releaseHash,
          exportHash:
            result.manifest.exportHash,
          videoSha256:
            result.manifest.videoSha256,
          qaReportHash:
            result.manifest.qaReportHash,
        });

      const valid = await this.validate(
        jobId,
        checkpoint,
      );

      if (!valid) {
        throw new Error(
          "M9 export checkpoint verification failed",
        );
      }

      return {
        stageId: VIDEO_EXPORT_STAGE_ID,
        jobId,
        reused: result.reused,
        checkpoint,
      };
    },

    async validate(jobId, candidate) {
      const parsed =
        VideoExportCheckpointSchema.safeParse(
          candidate,
        );

      if (
        !parsed.success ||
        parsed.data.jobId !== jobId
      ) {
        return false;
      }

      try {
        if (!await store.validate(jobId)) {
          return false;
        }

        const manifest =
          await store.loadVerifiedManifest(jobId);

        if (!manifest) {
          return false;
        }

        const expected =
          VideoExportCheckpointSchema.parse({
            version: 1,
            jobId,
            releaseHash: manifest.releaseHash,
            exportHash: manifest.exportHash,
            videoSha256:
              manifest.videoSha256,
            qaReportHash:
              manifest.qaReportHash,
          });

        return (
          JSON.stringify(parsed.data) ===
          JSON.stringify(expected)
        );
      } catch {
        return false;
      }
    },
  };
}
