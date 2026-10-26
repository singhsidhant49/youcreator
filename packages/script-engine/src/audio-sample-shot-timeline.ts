import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ShotNarrationAnchorPackageSchema,
  type ShotNarrationAnchorPackage,
} from "./shot-narration-anchors.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const AudioSampleShotSchema = z.object({
  version: z.literal(1),

  shotId: z.string().min(1),
  shotIndex: z.number().int().nonnegative(),

  startTokenIndex: z.number().int().nonnegative(),
  endTokenIndexExclusive: z.number().int().positive(),

  startSample: z.number().int().nonnegative(),
  endSampleExclusive: z.number().int().positive(),
  durationSamples: z.number().int().positive(),

  speechStartSample: z.number().int().nonnegative(),
  speechEndSampleExclusive: z.number().int().nonnegative(),
}).strict();

export type AudioSampleShot = z.infer<typeof AudioSampleShotSchema>;

export const AudioSampleShotTimelineSchema = z.object({
  version: z.literal(1),

  jobId: z.string().min(1),

  productionPackageHash: HashSchema,
  scriptHash: HashSchema,
  audioSha256: HashSchema,
  alignmentHash: HashSchema,
  anchorPackageHash: HashSchema,

  sampleRate: z.number().int().positive(),
  totalSamples: z.number().int().positive(),

  shotCount: z.number().int().positive(),

  shots: z.array(AudioSampleShotSchema).min(1),

  timelineHash: HashSchema,
}).strict();

export type AudioSampleShotTimeline = z.infer<
  typeof AudioSampleShotTimelineSchema
>;

export interface CreateAudioSampleShotTimelineInput {
  anchors: ShotNarrationAnchorPackage;

  /**
   * Optional independently verified M3 shot list.
   *
   * Native integration must provide this list.
   */
  authoritativeShotIds?: readonly string[];
}

function sha256(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("hex");
}

function verifyAnchorHash(
  anchors: ShotNarrationAnchorPackage,
): void {
  const {
    anchorPackageHash,
    ...payload
  } = anchors;

  if (
    sha256(JSON.stringify(payload)) !==
    anchorPackageHash
  ) {
    throw new Error(
      "Audio timeline anchor integrity mismatch",
    );
  }
}

export function createAudioSampleShotTimeline(
  input: CreateAudioSampleShotTimelineInput,
): AudioSampleShotTimeline {
  const anchors =
    ShotNarrationAnchorPackageSchema.parse(
      input.anchors,
    );

  verifyAnchorHash(anchors);

  if (
    anchors.anchors.length !==
      anchors.shotCount
  ) {
    throw new Error(
      "Audio timeline shot count mismatch",
    );
  }

  if (
    anchors.sampleFrames <= 0 ||
    anchors.sampleRate <= 0
  ) {
    throw new Error(
      "Audio timeline sample metadata invalid",
    );
  }

  if (input.authoritativeShotIds) {
    if (
      input.authoritativeShotIds.length !==
      anchors.shotCount
    ) {
      throw new Error(
        "Audio timeline authoritative shot count mismatch",
      );
    }

    for (
      let i = 0;
      i < anchors.shotCount;
      i++
    ) {
      if (
        input.authoritativeShotIds[i] !==
        anchors.anchors[i]?.shotId
      ) {
        throw new Error(
          `Audio timeline M3 shot mismatch at ${i}`,
        );
      }
    }
  }

  let previousEndSample = 0;
  let previousTokenEnd = 0;

  const shots = anchors.anchors.map(
    (anchor, index) => {
      if (
        anchor.shotIndex !== index ||
        anchor.startTokenIndex !==
          previousTokenEnd ||
        anchor.endTokenIndexExclusive <=
          anchor.startTokenIndex
      ) {
        throw new Error(
          `Audio timeline anchor ordering invalid at ${index}`,
        );
      }

      const nextAnchor =
        anchors.anchors[index + 1];

      // The following shot begins when its first
      // assigned narration token begins.
      //
      // This assigns silence between shots to the
      // preceding shot.
      const endSampleExclusive = nextAnchor
        ? nextAnchor.startSample
        : anchors.sampleFrames;

      const startSample = previousEndSample;

      if (
        startSample >= endSampleExclusive ||
        endSampleExclusive >
          anchors.sampleFrames ||
        anchor.startSample < startSample ||
        anchor.endSampleExclusive >
          endSampleExclusive
      ) {
        throw new Error(
          `Audio timeline invalid shot duration at ${index}`,
        );
      }

      const shot = AudioSampleShotSchema.parse({
        version: 1,

        shotId: anchor.shotId,
        shotIndex: index,

        startTokenIndex:
          anchor.startTokenIndex,

        endTokenIndexExclusive:
          anchor.endTokenIndexExclusive,

        startSample,
        endSampleExclusive,

        durationSamples:
          endSampleExclusive - startSample,

        speechStartSample:
          anchor.startSample,

        speechEndSampleExclusive:
          anchor.endSampleExclusive,
      });

      previousEndSample =
        endSampleExclusive;

      previousTokenEnd =
        anchor.endTokenIndexExclusive;

      return shot;
    },
  );

  if (
    previousEndSample !==
    anchors.sampleFrames ||
    previousTokenEnd !==
    anchors.tokenCount
  ) {
    throw new Error(
      "Audio timeline does not cover all audio or tokens",
    );
  }

  const payload = {
    version: 1 as const,

    jobId: anchors.jobId,

    productionPackageHash:
      anchors.productionPackageHash,

    scriptHash: anchors.scriptHash,

    audioSha256: anchors.audioSha256,

    alignmentHash: anchors.alignmentHash,

    anchorPackageHash:
      anchors.anchorPackageHash,

    sampleRate: anchors.sampleRate,

    totalSamples: anchors.sampleFrames,

    shotCount: shots.length,

    shots,
  };

  return AudioSampleShotTimelineSchema.parse({
    ...payload,
    timelineHash: sha256(
      JSON.stringify(payload),
    ),
  });
}

export function verifyAudioSampleShotTimeline(
  candidate: unknown,
  input: CreateAudioSampleShotTimelineInput,
): AudioSampleShotTimeline {
  const saved =
    AudioSampleShotTimelineSchema.parse(
      candidate,
    );

  const rebuilt =
    createAudioSampleShotTimeline(
      input,
    );

  if (
    JSON.stringify(saved) !==
    JSON.stringify(rebuilt)
  ) {
    throw new Error(
      "Audio timeline canonical reconstruction mismatch",
    );
  }

  return saved;
}
