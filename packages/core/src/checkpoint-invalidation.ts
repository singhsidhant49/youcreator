import { rm } from "node:fs/promises";
import path from "node:path";
import {
  PipelineStageIdSchema,
  type PipelineStageId,
} from "@youcreator/contracts";

export const CANONICAL_STAGE_ORDER: PipelineStageId[] = [
  "script",
  "storyboard",
  "media",
  "visual",
  "audio_aligned_visual",
  "video",
  "quality_assurance",
  "video_export",
];

export async function invalidateCheckpointsFrom(
  jobDirectory: string,
  fromStageId: PipelineStageId,
): Promise<PipelineStageId[]> {
  PipelineStageIdSchema.parse(fromStageId);

  const startIndex = CANONICAL_STAGE_ORDER.indexOf(fromStageId);
  if (startIndex === -1) {
    return [];
  }

  const invalidated: PipelineStageId[] = [];
  const checkpointsDir = path.join(jobDirectory, "checkpoints");

  for (let i = startIndex; i < CANONICAL_STAGE_ORDER.length; i++) {
    const stageId = CANONICAL_STAGE_ORDER[i]!;
    const checkpointFile = path.join(checkpointsDir, `${stageId}.json`);

    try {
      await rm(checkpointFile, { force: true });
      invalidated.push(stageId);
    } catch {
      // Ignore missing files
    }
  }

  return invalidated;
}
