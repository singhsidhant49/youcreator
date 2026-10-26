import { z } from "zod";
import { VideoConfigSchema } from "./video.js";

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const VideoJobSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),

  config: VideoConfigSchema,

  status: JobStatusSchema,

  createdAt: z.string().datetime(),

  updatedAt: z.string().datetime(),

  error: z.string().optional(),
});

export type VideoJob = z.infer<
  typeof VideoJobSchema
>;