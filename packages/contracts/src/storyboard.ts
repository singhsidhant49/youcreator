import { z } from "zod";

export const VisualIntentSchema = z.enum([
  "establishing",
  "illustration",
  "demonstration",
  "character",
  "atmosphere",
  "transition",
]);

export const MediaKindSchema = z.enum([
  "image",
  "video",
  "either",
]);

export const VisualRequestSchema = z.object({
  description: z.string().trim().min(10),

  searchQueries: z.array(
    z.string().trim().min(2),
  ).max(5),

  negativeTerms: z.array(
    z.string().trim().min(2),
  ).default([]),

  intent: VisualIntentSchema,

  preferredMediaKind: MediaKindSchema,

  // Desired composition, not a resolved asset.
  composition: z.string().trim().optional(),
}).strict();

export const StoryboardShotSchema = z.object({
  id: z.string().min(1),

  narrationText: z.string().trim().min(1),

  visualRequest: VisualRequestSchema,

  estimatedDurationSeconds:
    z.number().positive(),

  motion: z.enum([
    "static",
    "slow_zoom_in",
    "slow_zoom_out",
    "pan_left",
    "pan_right",
  ]).default("slow_zoom_in"),

  transition: z.enum([
    "cut",
    "crossfade",
  ]).default("cut"),
}).strict();

export const StoryboardSceneSchema = z.object({
  id: z.string().min(1),
  purpose: z.string().trim().min(1),

  shots: z.array(
    StoryboardShotSchema,
  ).min(1),
}).strict();

export const StoryboardSectionSchema = z.object({
  id: z.string().min(1),

  // Links to hook / section / outro narration.
  scriptSegmentId: z.string().min(1),

  title: z.string().min(1),

  scenes: z.array(
    StoryboardSceneSchema,
  ).min(1),
}).strict();

export const StoryboardSchema = z.object({
  version: z.literal(1),

  scriptTitle: z.string().min(1),

  sections: z.array(
    StoryboardSectionSchema,
  ).min(1),
}).strict();

export type VisualRequest = z.infer<
  typeof VisualRequestSchema
>;

export type StoryboardShot = z.infer<
  typeof StoryboardShotSchema
>;

export type StoryboardScene = z.infer<
  typeof StoryboardSceneSchema
>;

export type StoryboardSection = z.infer<
  typeof StoryboardSectionSchema
>;

export type Storyboard = z.infer<
  typeof StoryboardSchema
>;
