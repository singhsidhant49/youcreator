import { createHash } from "node:crypto";
import { z } from "zod";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Frame = z.number().int().safe().nonnegative();

export const VideoQaFrameSampleSchema = z.object({
  frame: Frame,
  shotId: z.string().min(1),
  shotIndex: Frame,
  position: z.enum([
    "start",
    "middle",
    "end",
    "interval",
  ]),
}).strict();

export const VideoQaFramePlanSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  compositionHash: Hash,
  fps: z.number().int().positive(),
  totalFrames: z.number().int().positive(),
  samples: z.array(VideoQaFrameSampleSchema).min(1),
  planHash: Hash,
}).strict();

export type VideoQaFramePlan = z.infer<
  typeof VideoQaFramePlanSchema
>;

export type VideoQaFrameSample = z.infer<
  typeof VideoQaFrameSampleSchema
>;

export interface VideoQaFramePlanOptions {
  intervalSeconds?: number;
  maxSamples?: number;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function createVideoQaFramePlan(
  manifestInput: RemotionComposition,
  options: VideoQaFramePlanOptions = {},
): VideoQaFramePlan {
  const manifest =
    RemotionCompositionSchema.parse(manifestInput);

  const intervalSeconds =
    options.intervalSeconds ?? 2;

  const maxSamples =
    options.maxSamples ?? 5000;

  if (
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < 1 ||
    !Number.isSafeInteger(maxSamples) ||
    maxSamples < 1
  ) {
    throw new Error(
      "M8 invalid frame sampling options",
    );
  }

  const intervalFrames =
    intervalSeconds * manifest.fps;

  if (!Number.isSafeInteger(intervalFrames)) {
    throw new Error(
      "M8 frame interval exceeds safe range",
    );
  }

  const samples: VideoQaFrameSample[] = [];

  for (const shot of manifest.shots) {
    const candidates = new Map<
      number,
      VideoQaFrameSample["position"]
    >();

    // A one-frame shot produces one unique sample.
    candidates.set(
      shot.startFrame,
      "start",
    );

    const middle = shot.startFrame +
      Math.floor(
        (shot.durationFrames - 1) / 2,
      );

    candidates.set(middle, "middle");

    const end = shot.endFrameExclusive - 1;

    candidates.set(end, "end");

    for (
      let frame =
        shot.startFrame + intervalFrames;
      frame < shot.endFrameExclusive;
      frame += intervalFrames
    ) {
      if (!candidates.has(frame)) {
        candidates.set(frame, "interval");
      }
    }

    const sorted = [...candidates.entries()]
      .sort((a, b) => a[0] - b[0]);

    for (const [frame, position] of sorted) {
      samples.push({
        frame,
        shotId: shot.shotId,
        shotIndex: shot.shotIndex,
        position,
      });

      if (samples.length > maxSamples) {
        throw new Error(
          "M8 QA frame sample limit exceeded",
        );
      }
    }
  }

  const payload = {
    version: 1 as const,
    jobId: manifest.jobId,
    compositionHash: manifest.compositionHash,
    fps: manifest.fps,
    totalFrames: manifest.totalFrames,
    samples,
  };

  return VideoQaFramePlanSchema.parse({
    ...payload,
    planHash: hash(payload),
  });
}

export function verifyVideoQaFramePlan(
  candidate: unknown,
  manifest: RemotionComposition,
  options: VideoQaFramePlanOptions = {},
): VideoQaFramePlan {
  const saved =
    VideoQaFramePlanSchema.parse(candidate);

  const canonical =
    createVideoQaFramePlan(manifest, options);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(canonical)
  ) {
    throw new Error(
      "M8 QA frame plan reconstruction mismatch",
    );
  }

  return saved;
}
