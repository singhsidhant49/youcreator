import { z } from "zod";
import {
  CanonicalVisualModeSchema,
  LegacyVisualModeSchema,
  VisualModeAliasSchema,
  VisualModeConfigurationSchema,
  resolveCanonicalVisualMode,
} from "./visual-mode.js";

/**
 * Historical video modes enum ("A" | "B" | "C" | "D").
 * Preserved for full backward compatibility with M1-M10.5 contracts.
 */
export const VideoModeSchema = LegacyVisualModeSchema;

export type VideoMode = z.infer<typeof VideoModeSchema>;

/**
 * Video configuration schema supporting both:
 * - Version 1 (legacy unversioned or version 1 with modes A, B, C, D)
 * - Version 2 (canonical modes A, B, C and aliases stock, ai, manual)
 */
export const VideoConfigSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).optional(),

  title: z.string().min(1),

  mode: z.union([
    CanonicalVisualModeSchema,
    LegacyVisualModeSchema,
    VisualModeAliasSchema,
  ]),

  canonicalMode: CanonicalVisualModeSchema.optional(),

  visualModeConfig: VisualModeConfigurationSchema.optional(),

  durationSeconds: z.number().positive(),

  resolution: z.enum([
    "1920x1080",
    "1080x1920",
    "1080x1080",
    "1280x720",
    "720x1280",
  ]).default("1920x1080"),

  fps: z.union([
    z.literal(24),
    z.literal(30),
    z.literal(60),
  ]).default(30),

  prompt: z.string().min(1).optional(),

  topic: z.string().min(1).optional(),

  aspectRatio: z.string().optional(),

  profile: z.enum(["explainer", "documentary", "story"]).optional(),

  profileId: z.enum(["explainer", "documentary", "story"]).optional(),

  durationToleranceSeconds: z.number().nonnegative().optional(),

  voice: z.string().optional(),

  voiceSpeed: z.number().positive().optional(),

  imageProvider: z.string().optional(),

  imageModel: z.string().optional(),

  imageQuality: z.string().optional(),

  imageResolution: z.string().optional(),

  maxCostPerImageUsd: z.number().positive().optional(),

  maxCostPerJobUsd: z.number().positive().optional(),

  musicEnabled: z.boolean().optional(),

  musicAssetId: z.string().optional(),

  styleGuide: z.string().optional(),

  assignments: z.array(
    z.object({
      shotId: z.string().min(1),
      assetId: z.string().min(1),
      localPath: z.string().min(1),
    }),
  ).optional(),
});

export type VideoConfig = z.infer<
  typeof VideoConfigSchema
>;

/**
 * Helper to resolve the canonical visual mode and configuration for any VideoConfig.
 */
export function resolveConfigVisualMode(config: VideoConfig) {
  return resolveCanonicalVisualMode({
    version: config.version,
    mode: config.mode,
  });
}