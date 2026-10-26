import { z } from "zod";

export const VideoBriefSchema = z.object({
  topic: z.string().trim().min(3),
  durationSeconds: z.number().int().min(30).max(10800),

  language: z.string().min(2).default("en"),
  tone: z.string().min(1).default("engaging documentary"),
  audience: z.string().min(1).default("general"),

  instructions: z.string().optional(),
});

export type VideoBriefInput = z.input<
  typeof VideoBriefSchema
>;

export type VideoBrief = z.output<
  typeof VideoBriefSchema
>;
