import { createHash } from "node:crypto";
import { z } from "zod";

import {
  AudioSampleShotTimelineSchema,
  type AudioSampleShotTimeline,
} from "./audio-sample-shot-timeline.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const AudioAlignedFrameShotSchema = z.object({
  version: z.literal(1),

  shotId: z.string().min(1),
  shotIndex: z.number().int().nonnegative(),

  startTokenIndex: z.number().int().nonnegative(),
  endTokenIndexExclusive: z.number().int().positive(),

  startSample: z.number().int().nonnegative(),
  endSampleExclusive: z.number().int().positive(),

  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
  durationFrames: z.number().int().positive(),
}).strict();

export const AudioAlignedFramePlanSchema = z.object({
  version: z.literal(1),

  jobId: z.string().min(1),

  productionPackageHash: HashSchema,
  scriptHash: HashSchema,
  audioSha256: HashSchema,
  alignmentHash: HashSchema,
  anchorPackageHash: HashSchema,
  sampleTimelineHash: HashSchema,

  sampleRate: z.number().int().positive(),
  totalSamples: z.number().int().positive(),

  fps: z.number().int().positive(),
  totalFrames: z.number().int().positive(),
  shotCount: z.number().int().positive(),

  shots: z.array(AudioAlignedFrameShotSchema).min(1),

  framePlanHash: HashSchema,
}).strict();

export type AudioAlignedFramePlan = z.infer<
  typeof AudioAlignedFramePlanSchema
>;

export interface CreateAudioAlignedFramePlanInput {
  timeline: AudioSampleShotTimeline;
  fps: number;

  /**
   * Native integration should pass the actual
   * shot IDs extracted from verified M3.
   */
  authoritativeShotIds?: readonly string[];
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function safeInteger(
  value: number,
  name: string,
): bigint {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `Invalid ${name}`,
    );
  }

  return BigInt(value);
}

function safeNumber(
  value: bigint,
): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      "Frame boundary exceeds safe integer range",
    );
  }

  return Number(value);
}

/**
 * Nearest integer rounding for nonnegative
 * rational frame positions.
 */
export function roundSampleToFrame(
  sample: number,
  sampleRate: number,
  fps: number,
): number {
  const s = safeInteger(sample, "sample boundary");
  const r = safeInteger(sampleRate, "sample rate");
  const f = safeInteger(fps, "frame rate");

  if (r === 0n || f === 0n) {
    throw new Error(
      "Sample rate and FPS must be positive",
    );
  }

  return safeNumber(
    (s * f * 2n + r) / (2n * r),
  );
}

/**
 * Ceiling on the final audio duration.
 * Ensures the video cannot end before the WAV.
 */
export function ceilSampleToFrame(
  sample: number,
  sampleRate: number,
  fps: number,
): number {
  const s = safeInteger(sample, "sample boundary");
  const r = safeInteger(sampleRate, "sample rate");
  const f = safeInteger(fps, "frame rate");

  if (r === 0n || f === 0n) {
    throw new Error(
      "Sample rate and FPS must be positive",
    );
  }

  return safeNumber(
    (s * f + r - 1n) / r,
  );
}

function verifyTimelineIntegrity(
  timeline: AudioSampleShotTimeline,
): void {
  const {
    timelineHash,
    ...payload
  } = timeline;

  if (
    timelineHash !== sha256(payload)
  ) {
    throw new Error(
      "Audio frame plan timeline integrity mismatch",
    );
  }
}

export function createAudioAlignedFramePlan(
  input: CreateAudioAlignedFramePlanInput,
): AudioAlignedFramePlan {
  const timeline =
    AudioSampleShotTimelineSchema.parse(
      input.timeline,
    );

  verifyTimelineIntegrity(timeline);

  if (
    !Number.isSafeInteger(input.fps) ||
    input.fps <= 0
  ) {
    throw new Error(
      "Invalid audio frame plan FPS",
    );
  }

  if (
    timeline.shotCount !== timeline.shots.length
  ) {
    throw new Error(
      "Audio frame plan shot count mismatch",
    );
  }

  if (
    input.authoritativeShotIds &&
    (
      input.authoritativeShotIds.length !==
      timeline.shotCount ||
      input.authoritativeShotIds.some(
        (id, index) =>
          id !== timeline.shots[index]?.shotId,
      )
    )
  ) {
    throw new Error(
      "Audio frame plan authoritative M3 mismatch",
    );
  }

  const totalFrames = ceilSampleToFrame(
    timeline.totalSamples,
    timeline.sampleRate,
    input.fps,
  );

  let previousSample = 0;
  let previousFrame = 0;
  let previousToken = 0;

  const shots = timeline.shots.map(
    (shot, index) => {
      if (
        shot.shotIndex !== index ||
        shot.startSample !== previousSample ||
        shot.endSampleExclusive <= shot.startSample ||
        shot.endSampleExclusive > timeline.totalSamples ||
        shot.durationSamples !==
          shot.endSampleExclusive - shot.startSample ||
        shot.startTokenIndex !== previousToken ||
        shot.endTokenIndexExclusive <=
          shot.startTokenIndex
      ) {
        throw new Error(
          `Audio frame plan invalid sample timeline at ${index}`,
        );
      }

      const isLast =
        index === timeline.shots.length - 1;

      const endFrameExclusive = isLast
        ? totalFrames
        : roundSampleToFrame(
            shot.endSampleExclusive,
            timeline.sampleRate,
            input.fps,
          );

      if (
        endFrameExclusive <= previousFrame ||
        endFrameExclusive > totalFrames
      ) {
        throw new Error(
          `Audio frame plan zero-duration or invalid shot at ${index}`,
        );
      }

      const frameShot =
        AudioAlignedFrameShotSchema.parse({
          version: 1,

          shotId: shot.shotId,
          shotIndex: index,

          startTokenIndex:
            shot.startTokenIndex,

          endTokenIndexExclusive:
            shot.endTokenIndexExclusive,

          startSample: shot.startSample,
          endSampleExclusive:
            shot.endSampleExclusive,

          startFrame: previousFrame,
          endFrameExclusive,

          durationFrames:
            endFrameExclusive - previousFrame,
        });

      previousSample =
        shot.endSampleExclusive;

      previousFrame =
        endFrameExclusive;

      previousToken =
        shot.endTokenIndexExclusive;

      return frameShot;
    },
  );

  if (
    previousSample !== timeline.totalSamples ||
    previousFrame !== totalFrames
  ) {
    throw new Error(
      "Audio frame plan does not cover narration",
    );
  }

  const payload = {
    version: 1 as const,
    jobId: timeline.jobId,

    productionPackageHash:
      timeline.productionPackageHash,

    scriptHash: timeline.scriptHash,
    audioSha256: timeline.audioSha256,
    alignmentHash: timeline.alignmentHash,

    anchorPackageHash:
      timeline.anchorPackageHash,

    sampleTimelineHash:
      timeline.timelineHash,

    sampleRate: timeline.sampleRate,
    totalSamples: timeline.totalSamples,

    fps: input.fps,
    totalFrames,
    shotCount: shots.length,
    shots,
  };

  return AudioAlignedFramePlanSchema.parse({
    ...payload,
    framePlanHash: sha256(payload),
  });
}

export function verifyAudioAlignedFramePlan(
  candidate: unknown,
  input: CreateAudioAlignedFramePlanInput,
): AudioAlignedFramePlan {
  const saved =
    AudioAlignedFramePlanSchema.parse(
      candidate,
    );

  const rebuilt =
    createAudioAlignedFramePlan(input);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(rebuilt)
  ) {
    throw new Error(
      "Audio frame plan canonical reconstruction mismatch",
    );
  }

  return saved;
}
