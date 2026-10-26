import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ShotMotionPackageSchema,
  type ShotMotion,
  type ShotMotionPackage,
} from "./shot-motion-plan.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const EPSILON = 0.00001;

const CanonicalShotTimingSchema = z.object({
  shotId: z.string().min(1),
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
}).strict();

export type CanonicalShotTiming = z.infer<
  typeof CanonicalShotTimingSchema
>;

const CropSchema = z.object({
  left: z.number().finite().nonnegative(),
  top: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();

export const ShotFrameGeometrySchema = z.object({
  version: z.literal(1),

  shotId: z.string().min(1),
  shotIndex: z.number().int().nonnegative(),

  bindingHash: HashSchema,
  assetSha256: HashSchema,

  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
  durationFrames: z.number().int().positive(),

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

  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),

  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),

  startCrop: CropSchema.nullable(),
  endCrop: CropSchema.nullable(),
}).strict();

export type ShotFrameGeometry = z.infer<
  typeof ShotFrameGeometrySchema
>;

export const ShotFrameGeometryPackageSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),

  motionPackageHash: HashSchema,

  fps: z.number().int().positive(),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),

  totalFrames: z.number().int().positive(),

  shots: z.array(
    ShotFrameGeometrySchema,
  ).min(1),

  geometryPackageHash: HashSchema,
}).strict();

export type ShotFrameGeometryPackage = z.infer<
  typeof ShotFrameGeometryPackageSchema
>;

export interface CreateShotFrameGeometryInput {
  motionPlan: ShotMotionPackage;

  /**
   * Must originate from the authoritative M3
   * narration/shot timeline, not an API client.
   */
  timings: CanonicalShotTiming[];

  fps?: number;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Convert a focal point and zoom into an image-space
 * crop rectangle.
 *
 * The crop is always fully contained within the
 * original source image.
 *
 * Coordinates use source pixels and can be
 * converted to CSS/Remotion transforms later.
 */
export function calculateSafeCoverCrop(
  shot: ShotMotion,
  point: "start" | "end",
): z.infer<typeof CropSchema> {
  if (shot.fit !== "cover") {
    throw new Error(
      "Cover crop cannot be calculated for contain fit",
    );
  }

  const scale = point === "start"
    ? shot.startScale
    : shot.endScale;

  const focalX = point === "start"
    ? shot.startX
    : shot.endX;

  const focalY = point === "start"
    ? shot.startY
    : shot.endY;

  const baseScale = Math.max(
    shot.frameWidth / shot.sourceWidth,
    shot.frameHeight / shot.sourceHeight,
  );

  const effectiveScale = baseScale * scale;

  const cropWidth = Math.min(
    shot.sourceWidth,
    shot.frameWidth / effectiveScale,
  );

  const cropHeight = Math.min(
    shot.sourceHeight,
    shot.frameHeight / effectiveScale,
  );

  const wantedLeft =
    focalX * shot.sourceWidth -
    cropWidth / 2;

  const wantedTop =
    focalY * shot.sourceHeight -
    cropHeight / 2;

  const left = Math.max(
    0,
    Math.min(
      wantedLeft,
      shot.sourceWidth - cropWidth,
    ),
  );

  const top = Math.max(
    0,
    Math.min(
      wantedTop,
      shot.sourceHeight - cropHeight,
    ),
  );

  const crop = {
    left: round(left),
    top: round(top),
    width: round(cropWidth),
    height: round(cropHeight),
  };

  return CropSchema.parse(crop);
}

export function createShotFrameGeometry(
  input: CreateShotFrameGeometryInput,
): ShotFrameGeometryPackage {
  const motionPlan =
    ShotMotionPackageSchema.parse(
      input.motionPlan,
    );

  const fps = input.fps ?? 30;

  if (
    !Number.isSafeInteger(fps) ||
    fps < 1 ||
    fps > 120
  ) {
    throw new Error(
      "FPS must be an integer between 1 and 120",
    );
  }

  const timings = z.array(
    CanonicalShotTimingSchema,
  ).min(1).parse(input.timings);

  if (
    timings.length !==
    motionPlan.shots.length
  ) {
    throw new Error(
      "Timeline shot coverage does not match motion plan",
    );
  }

  const shots: ShotFrameGeometry[] = [];

  let previousEndSeconds = 0;
  let previousEndFrame = 0;

  for (
    let index = 0;
    index < motionPlan.shots.length;
    index += 1
  ) {
    const shot = motionPlan.shots[index]!;
    const timing = timings[index]!;

    if (
      timing.shotId !== shot.shotId ||
      shot.shotIndex !== index
    ) {
      throw new Error(
        `Noncanonical timeline shot order at index ${index}`,
      );
    }

    if (
      timing.endSeconds <= timing.startSeconds
    ) {
      throw new Error(
        `Invalid timeline duration: ${shot.shotId}`,
      );
    }

    if (
      Math.abs(
        timing.startSeconds -
        previousEndSeconds,
      ) > EPSILON
    ) {
      throw new Error(
        `Timeline gap or overlap: ${shot.shotId}`,
      );
    }

    const durationSeconds =
      timing.endSeconds -
      timing.startSeconds;

    if (
      Math.abs(
        durationSeconds -
        shot.durationSeconds,
      ) > EPSILON
    ) {
      throw new Error(
        `Motion duration disagrees with M3 timeline: ${shot.shotId}`,
      );
    }

    /**
     * Use cumulative absolute frame boundaries.
     *
     * Rounding each duration separately and then
     * adding them causes gradual timing drift.
     */
    const startFrame = previousEndFrame;

    const endFrameExclusive = Math.round(
      timing.endSeconds * fps,
    );

    const durationFrames =
      endFrameExclusive - startFrame;

    if (durationFrames < 1) {
      throw new Error(
        `Shot is shorter than one output frame: ${shot.shotId}`,
      );
    }

    const startCrop =
      shot.fit === "cover"
        ? calculateSafeCoverCrop(
            shot,
            "start",
          )
        : null;

    const endCrop =
      shot.fit === "cover"
        ? calculateSafeCoverCrop(
            shot,
            "end",
          )
        : null;

    shots.push(
      ShotFrameGeometrySchema.parse({
        version: 1,

        shotId: shot.shotId,
        shotIndex: index,

        bindingHash: shot.bindingHash,
        assetSha256: shot.assetSha256,

        startFrame,
        endFrameExclusive,
        durationFrames,

        fit: shot.fit,
        motion: shot.motion,

        sourceWidth: shot.sourceWidth,
        sourceHeight: shot.sourceHeight,

        frameWidth: shot.frameWidth,
        frameHeight: shot.frameHeight,

        startCrop,
        endCrop,
      }),
    );

    previousEndSeconds = timing.endSeconds;
    previousEndFrame = endFrameExclusive;
  }

  const payload = {
    version: 1 as const,
    jobId: motionPlan.jobId,

    motionPackageHash:
      motionPlan.motionPackageHash,

    fps,

    frameWidth: motionPlan.frameWidth,
    frameHeight: motionPlan.frameHeight,

    totalFrames: previousEndFrame,
    shots,
  };

  return ShotFrameGeometryPackageSchema.parse({
    ...payload,
    geometryPackageHash: hash(payload),
  });
}

export interface ExactShotFrameTiming {
  shotId: string;
  shotIndex: number;
  startFrame: number;
  endFrameExclusive: number;
  durationFrames: number;
}

export interface CreateExactShotFrameGeometryInput {
  motionPlan: ShotMotionPackage;
  frameTimings: ExactShotFrameTiming[];
  fps: number;
  totalFrames: number;
}

/**
 * M6 exact-frame geometry path.
 *
 * Reuses the existing M5 motion schema,
 * crop calculation and geometry schemas.
 *
 * Does not convert frames back into seconds.
 */
export function createShotFrameGeometryFromFrames(
  input: CreateExactShotFrameGeometryInput,
): ShotFrameGeometryPackage {
  const motionPlan =
    ShotMotionPackageSchema.parse(input.motionPlan);

  const fps = input.fps;

  if (
    !Number.isSafeInteger(fps) ||
    fps < 1 ||
    fps > 120
  ) {
    throw new Error(
      "FPS must be an integer between 1 and 120",
    );
  }

  if (
    !Number.isSafeInteger(input.totalFrames) ||
    input.totalFrames < 1
  ) {
    throw new Error(
      "Invalid exact geometry total frames",
    );
  }

  const FrameTimingSchema = z.object({
    shotId: z.string().min(1),
    shotIndex: z.number().int().nonnegative(),
    startFrame: z.number().int().nonnegative(),
    endFrameExclusive:
      z.number().int().positive(),
    durationFrames:
      z.number().int().positive(),
  }).strict();

  const timings = z.array(
    FrameTimingSchema,
  ).min(1).parse(input.frameTimings);

  if (
    timings.length !== motionPlan.shots.length
  ) {
    throw new Error(
      "Exact geometry shot coverage mismatch",
    );
  }

  let previousEndFrame = 0;

  const shots: ShotFrameGeometry[] =
    motionPlan.shots.map((shot, index) => {
      const timing = timings[index]!;

      if (
        shot.shotIndex !== index ||
        timing.shotIndex !== index ||
        timing.shotId !== shot.shotId
      ) {
        throw new Error(
          `Exact geometry shot mismatch at ${index}`,
        );
      }

      if (
        timing.startFrame !== previousEndFrame ||
        timing.endFrameExclusive <=
          timing.startFrame ||
        timing.durationFrames !==
          timing.endFrameExclusive -
            timing.startFrame ||
        timing.endFrameExclusive >
          input.totalFrames
      ) {
        throw new Error(
          `Exact geometry frame continuity mismatch at ${index}`,
        );
      }

      const startCrop =
        shot.fit === "cover"
          ? calculateSafeCoverCrop(
              shot,
              "start",
            )
          : null;

      const endCrop =
        shot.fit === "cover"
          ? calculateSafeCoverCrop(
              shot,
              "end",
            )
          : null;

      const result =
        ShotFrameGeometrySchema.parse({
          version: 1,

          shotId: shot.shotId,
          shotIndex: index,

          bindingHash: shot.bindingHash,
          assetSha256: shot.assetSha256,

          startFrame: timing.startFrame,
          endFrameExclusive:
            timing.endFrameExclusive,
          durationFrames:
            timing.durationFrames,

          fit: shot.fit,
          motion: shot.motion,

          sourceWidth: shot.sourceWidth,
          sourceHeight: shot.sourceHeight,

          frameWidth: shot.frameWidth,
          frameHeight: shot.frameHeight,

          startCrop,
          endCrop,
        });

      previousEndFrame =
        timing.endFrameExclusive;

      return result;
    });

  if (
    previousEndFrame !== input.totalFrames
  ) {
    throw new Error(
      "Exact geometry total frame mismatch",
    );
  }

  const payload = {
    version: 1 as const,
    jobId: motionPlan.jobId,

    motionPackageHash:
      motionPlan.motionPackageHash,

    fps,

    frameWidth: motionPlan.frameWidth,
    frameHeight: motionPlan.frameHeight,

    totalFrames: input.totalFrames,
    shots,
  };

  return ShotFrameGeometryPackageSchema.parse({
    ...payload,
    geometryPackageHash: hash(payload),
  });
}

