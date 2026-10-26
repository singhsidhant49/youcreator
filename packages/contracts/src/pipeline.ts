import { z } from "zod";

export const PipelineStageStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export type PipelineStageStatus = z.infer<
  typeof PipelineStageStatusSchema
>;

export const PipelineStageIdSchema = z.enum([
  "script",
  "storyboard",
  "media",
  "visual",
  "audio_aligned_visual",
  "video",
  "quality_assurance",
  "video_export",
  "audio",
  "timeline",
  "render",
  "qa",
]);

export type PipelineStageId = z.infer<
  typeof PipelineStageIdSchema
>;

export const PipelineStageRunSchema = z.object({
  stageId: PipelineStageIdSchema,

  status: PipelineStageStatusSchema,

  startedAt: z.string().datetime().optional(),

  completedAt: z.string().datetime().optional(),

  inputHash: z.string().optional(),

  outputPath: z.string().optional(),

  error: z.string().optional(),
});

export type PipelineStageRun = z.infer<
  typeof PipelineStageRunSchema
>;