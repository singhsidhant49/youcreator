import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ShotMediaBindingPackageSchema,
  type ShotMediaBindingPackage,
} from "./shot-media-binding.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ShotDurationSchema = z.object({
  shotId: z.string().min(1),
  durationSeconds: z.number().finite().positive(),
}).strict();

export const ShotMotionSchema = z.object({
  version: z.literal(1),

  shotId: z.string().min(1),
  shotIndex: z.number().int().nonnegative(),

  assetSha256: HashSchema,
  bindingHash: HashSchema,

  durationSeconds: z.number().finite().positive(),

  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),

  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),

  fit: z.enum(["cover", "contain"]),

  motion: z.enum([
    "static",
    "zoom_in",
    "zoom_out",
    "pan_left",
    "pan_right",
    "pan_up",
    "pan_down",
  ]),

  startScale: z.number().min(1).max(1.2),
  endScale: z.number().min(1).max(1.2),

  startX: z.number().min(0).max(1),
  startY: z.number().min(0).max(1),

  endX: z.number().min(0).max(1),
  endY: z.number().min(0).max(1),
}).strict();

export type ShotMotion = z.infer<
  typeof ShotMotionSchema
>;

export const ShotMotionPackageSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),

  bindingPackageHash: HashSchema,

  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),

  shots: z.array(ShotMotionSchema).min(1),

  motionPackageHash: HashSchema,
}).strict();

export type ShotMotionPackage = z.infer<
  typeof ShotMotionPackageSchema
>;

export interface CreateShotMotionPlanInput {
  bindings: ShotMediaBindingPackage;

  durations: Array<{
    shotId: string;
    durationSeconds: number;
  }>;

  frameWidth?: number;
  frameHeight?: number;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Avoid extreme source/frame mismatches that would
 * crop away too much important visual information.
 */
function selectFit(
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
): "cover" | "contain" {
  const sourceRatio = sourceWidth / sourceHeight;
  const frameRatio = frameWidth / frameHeight;

  const mismatch = Math.max(
    sourceRatio / frameRatio,
    frameRatio / sourceRatio,
  );

  return mismatch > 1.75 ? "contain" : "cover";
}

/**
 * One repeatable movement per shot.
 *
 * No random numbers, dates, filesystem information,
 * or model-generated transformations.
 */
function selectMotion(
  assetHash: string,
  shotIndex: number,
  durationSeconds: number,
  fit: "cover" | "contain",
): ShotMotion["motion"] {
  if (fit === "contain" || durationSeconds < 2) {
    return "static";
  }

  const patterns: ShotMotion["motion"][] = [
    "zoom_in",
    "zoom_out",
  ];

  const seed = Number.parseInt(
    assetHash.slice(0, 8),
    16,
  );

  return patterns[
    (seed + shotIndex) % patterns.length
  ]!;
}

function motionCoordinates(
  motion: ShotMotion["motion"],
) {
  const center = 0.5;
  const offset = 0.025;

  switch (motion) {
    case "zoom_in":
      return {
        startScale: 1.03,
        endScale: 1.09,
        startX: center,
        startY: center,
        endX: center,
        endY: center,
      };

    case "zoom_out":
      return {
        startScale: 1.09,
        endScale: 1.03,
        startX: center,
        startY: center,
        endX: center,
        endY: center,
      };

    case "pan_left":
      return {
        startScale: 1.08,
        endScale: 1.08,
        startX: center + offset,
        startY: center,
        endX: center - offset,
        endY: center,
      };

    case "pan_right":
      return {
        startScale: 1.08,
        endScale: 1.08,
        startX: center - offset,
        startY: center,
        endX: center + offset,
        endY: center,
      };

    case "pan_up":
      return {
        startScale: 1.08,
        endScale: 1.08,
        startX: center,
        startY: center + offset,
        endX: center,
        endY: center - offset,
      };

    case "pan_down":
      return {
        startScale: 1.08,
        endScale: 1.08,
        startX: center,
        startY: center - offset,
        endX: center,
        endY: center + offset,
      };

    case "static":
      return {
        startScale: 1,
        endScale: 1,
        startX: center,
        startY: center,
        endX: center,
        endY: center,
      };
  }
}

export function createShotMotionPlan(
  input: CreateShotMotionPlanInput,
): ShotMotionPackage {
  const bindings =
    ShotMediaBindingPackageSchema.parse(
      input.bindings,
    );

  const frameWidth = input.frameWidth ?? 1920;
  const frameHeight = input.frameHeight ?? 1080;

  if (
    !Number.isSafeInteger(frameWidth) ||
    !Number.isSafeInteger(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    throw new Error("Invalid output frame dimensions");
  }

  const parsedDurations = z.array(
    ShotDurationSchema,
  ).parse(input.durations);

  const durationMap = new Map<
    string,
    number
  >();

  for (const item of parsedDurations) {
    if (durationMap.has(item.shotId)) {
      throw new Error(
        `Duplicate shot duration: ${item.shotId}`,
      );
    }

    durationMap.set(
      item.shotId,
      item.durationSeconds,
    );
  }

  if (
    durationMap.size !== bindings.bindings.length
  ) {
    throw new Error(
      "Shot duration coverage does not match media bindings",
    );
  }

  const shots = bindings.bindings.map(
    (binding, index) => {
      if (
        binding.shotIndex !== index
      ) {
        throw new Error(
          `Noncanonical shot index: ${binding.shotId}`,
        );
      }

      const durationSeconds =
        durationMap.get(binding.shotId);

      if (durationSeconds === undefined) {
        throw new Error(
          `Missing duration for shot: ${binding.shotId}`,
        );
      }

      const asset = binding.asset;

      if (
        asset.kind !== "image" ||
        !asset.width ||
        !asset.height
      ) {
        throw new Error(
          `Shot requires a dimensioned image: ${binding.shotId}`,
        );
      }

      const fit = selectFit(
        asset.width,
        asset.height,
        frameWidth,
        frameHeight,
      );

      const motion = selectMotion(
        asset.sha256,
        index,
        durationSeconds,
        fit,
      );

      const coords = motionCoordinates(motion);

      return ShotMotionSchema.parse({
        version: 1,
        shotId: binding.shotId,
        shotIndex: index,

        assetSha256: asset.sha256,
        bindingHash: binding.bindingHash,

        durationSeconds,

        frameWidth,
        frameHeight,

        sourceWidth: asset.width,
        sourceHeight: asset.height,

        fit,
        motion,

        startScale: round(coords.startScale),
        endScale: round(coords.endScale),

        startX: round(coords.startX),
        startY: round(coords.startY),

        endX: round(coords.endX),
        endY: round(coords.endY),
      });
    },
  );

  const payload = {
    version: 1 as const,
    jobId: bindings.jobId,

    bindingPackageHash:
      bindings.bindingPackageHash,

    frameWidth,
    frameHeight,

    shots,
  };

  return ShotMotionPackageSchema.parse({
    ...payload,
    motionPackageHash: hash(payload),
  });
}
