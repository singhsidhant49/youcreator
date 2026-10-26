import sharp from "sharp";
import { z } from "zod";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import type {
  VideoQaFramePlan,
} from "./video-qa-frame-plan.js";

export const VideoQaFrameFindingSchema = z.object({
  frame: z.number().int().safe().nonnegative(),
  shotId: z.string().min(1),
  code: z.enum([
    "BLACK_FRAME",
    "POSSIBLE_FROZEN_MOTION",
  ]),
  severity: z.enum(["warning", "error"]),
  detail: z.string().min(1),
}).strict();

export type VideoQaFrameFinding = z.infer<
  typeof VideoQaFrameFindingSchema
>;

export interface DecodedQaFrame {
  frame: number;
  png: Buffer;
}

export interface VideoQaFrameThresholds {
  blackMeanLuma?: number;
  blackPixelFraction?: number;
  blackPixelLuma?: number;
  frozenMeanDifference?: number;
  minMotionFrameInterval?: number;
  motionPlan?: {
    shots: ReadonlyArray<{
      shotId: string;
      movement: string;
    }>;
  };
}

export interface VideoQaFrameAnalysis {
  inspectedFrames: number;
  findings: VideoQaFrameFinding[];
}

interface FrameMetrics {
  frame: number;
  shotId: string;
  meanLuma: number;
  darkFraction: number;
  pixels: Buffer;
}

const ANALYSIS_WIDTH = 64;
const ANALYSIS_HEIGHT = 36;

export async function decodeFrameMetrics(
  input: DecodedQaFrame,
  shotId: string,
  blackPixelLuma = 12,
): Promise<FrameMetrics> {
  const {
    data,
    info,
  } = await sharp(input.png)
    .flatten({
      background: "#000000",
    })
    .resize(
      ANALYSIS_WIDTH,
      ANALYSIS_HEIGHT,
      { fit: "fill" },
    )
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (
    info.channels !== 3 ||
    data.length !==
      ANALYSIS_WIDTH *
      ANALYSIS_HEIGHT * 3
  ) {
    throw new Error(
      "M8 decoded frame dimensions invalid",
    );
  }

  let lumaSum = 0;
  let darkCount = 0;

  const pixelCount =
    ANALYSIS_WIDTH * ANALYSIS_HEIGHT;

  for (let i = 0; i < data.length; i += 3) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    const luma =
      0.2126 * r +
      0.7152 * g +
      0.0722 * b;

    lumaSum += luma;

    if (luma <= blackPixelLuma) {
      darkCount++;
    }
  }

  return {
    frame: input.frame,
    shotId,
    meanLuma: lumaSum / pixelCount,
    darkFraction: darkCount / pixelCount,
    pixels: data,
  };
}

export function meanPixelDifference(
  a: Buffer,
  b: Buffer,
): number {
  if (
    a.length === 0 ||
    a.length !== b.length
  ) {
    throw new Error(
      "M8 incompatible decoded frame buffers",
    );
  }

  let sum = 0;

  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i]! - b[i]!);
  }

  return sum / a.length;
}

export async function analyzeVideoQaFrames(
  manifest: RemotionComposition,
  plan: VideoQaFramePlan,
  frames: readonly DecodedQaFrame[],
  thresholds: VideoQaFrameThresholds = {},
): Promise<VideoQaFrameAnalysis> {
  if (
    plan.compositionHash !==
      manifest.compositionHash ||
    plan.jobId !== manifest.jobId ||
    plan.totalFrames !== manifest.totalFrames ||
    plan.fps !== manifest.fps
  ) {
    throw new Error(
      "M8 frame QA dependency mismatch",
    );
  }

  const blackMean =
    thresholds.blackMeanLuma ?? 8;

  const darkFractionThreshold =
    thresholds.blackPixelFraction ?? 0.985;

  const darkPixelLuma =
    thresholds.blackPixelLuma ?? 12;

  const frozenDifference =
    thresholds.frozenMeanDifference ?? 0.15;

  if (
    !Number.isFinite(blackMean) ||
    blackMean < 0 ||
    blackMean > 255 ||
    !Number.isFinite(darkFractionThreshold) ||
    darkFractionThreshold < 0 ||
    darkFractionThreshold > 1 ||
    !Number.isFinite(darkPixelLuma) ||
    darkPixelLuma < 0 ||
    darkPixelLuma > 255 ||
    !Number.isFinite(frozenDifference) ||
    frozenDifference < 0 ||
    frozenDifference > 255 ||
    (thresholds.minMotionFrameInterval !== undefined &&
      (!Number.isSafeInteger(thresholds.minMotionFrameInterval) ||
        thresholds.minMotionFrameInterval < 1))
  ) {
    throw new Error(
      "M8 invalid frame QA thresholds",
    );
  }

  const frameMap = new Map<number, Buffer>();

  for (const frame of frames) {
    if (
      frameMap.has(frame.frame) ||
      !Number.isSafeInteger(frame.frame)
    ) {
      throw new Error(
        "M8 duplicate or invalid decoded frame",
      );
    }

    frameMap.set(frame.frame, frame.png);
  }

  if (
    frameMap.size !== plan.samples.length
  ) {
    throw new Error(
      "M8 decoded frame coverage mismatch",
    );
  }

  const shotById = new Map(
    manifest.shots.map((shot) => [
      shot.shotId,
      shot,
    ]),
  );

  const findings: VideoQaFrameFinding[] = [];
  const previousByShot = new Map<
    string,
    FrameMetrics
  >();

  for (const sample of plan.samples) {
    const image = frameMap.get(sample.frame);

    if (!image) {
      throw new Error(
        `M8 missing decoded frame ${sample.frame}`,
      );
    }

    const shot = shotById.get(
      sample.shotId,
    );

    if (
      !shot ||
      sample.frame < shot.startFrame ||
      sample.frame >= shot.endFrameExclusive
    ) {
      throw new Error(
        "M8 frame-to-shot mapping mismatch",
      );
    }

    const metrics = await decodeFrameMetrics(
      {
        frame: sample.frame,
        png: image,
      },
      sample.shotId,
      darkPixelLuma,
    );

    if (
      metrics.meanLuma <= blackMean &&
      metrics.darkFraction >=
        darkFractionThreshold
    ) {
      findings.push({
        frame: sample.frame,
        shotId: sample.shotId,
        code: "BLACK_FRAME",
        severity: "error",
        detail:
          `Mean luma ${metrics.meanLuma.toFixed(2)}, ` +
          `dark pixels ${(metrics.darkFraction * 100).toFixed(2)}%`,
      });
    }

    const previous = previousByShot.get(
      sample.shotId,
    );

    const motionShot = thresholds.motionPlan?.shots.find(
      (s) => s.shotId === sample.shotId,
    );
    const isStatic = motionShot
      ? motionShot.movement === "static"
      : shot.motion === "static";

    if (
      previous &&
      !isStatic &&
      shot.durationFrames > 1
    ) {
      const frameDelta = sample.frame - previous.frame;
      const minInterval = thresholds.minMotionFrameInterval ?? 15;

      if (frameDelta >= minInterval) {
        const difference =
          meanPixelDifference(
            previous.pixels,
            metrics.pixels,
          );

        const intervalScale = Math.min(1, frameDelta / (plan.fps * 2));
        const effectiveThreshold = frozenDifference * intervalScale;

        if (difference <= effectiveThreshold) {
          findings.push({
            frame: sample.frame,
            shotId: sample.shotId,
            code: "POSSIBLE_FROZEN_MOTION",
            severity: "warning",
            detail:
              `Frames ${previous.frame} and ` +
              `${sample.frame}: mean pixel difference ` +
              difference.toFixed(4),
          });
        }
      }
    }

    previousByShot.set(
      sample.shotId,
      metrics,
    );
  }

  return {
    inspectedFrames: plan.samples.length,
    findings,
  };
}
