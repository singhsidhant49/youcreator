import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import {
  AudioAlignedVisualPackageSchema,
  type AudioAlignedVisualPackage,
} from "./audio-aligned-visual-reconstruction.js";

import {
  NarrationWordAlignmentSchema,
  type NarrationWordAlignment,
} from "./narration-alignment-contract.js";

import {
  RendererReadyVisualShotSchema,
} from "./renderer-ready-visual-package.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SafeInteger = z.number().int().safe();

export const RemotionNarrationSourceSchema = z.object({
  format: z.literal("wav_pcm_s16le"),

  path: z.string().min(1),
  sha256: HashSchema,

  sampleRate: SafeInteger.positive(),
  sampleFrames: SafeInteger.positive(),

  channels: z.literal(1),
  bitsPerSample: z.literal(16),
}).strict();

export const RemotionCompositionShotSchema =
  RendererReadyVisualShotSchema;

export const RemotionCompositionSchema = z.object({
  version: z.literal(1),

  compositionId: z.literal("YouCreatorNarratedV1"),
  jobId: z.string().min(1),

  productionPackageHash: HashSchema,
  m6VisualHash: HashSchema,
  visualPackageHash: HashSchema,

  framePlanHash: HashSchema,
  scriptHash: HashSchema,
  alignmentHash: HashSchema,
  audioSha256: HashSchema,

  fps: SafeInteger.min(1).max(120),
  width: SafeInteger.positive(),
  height: SafeInteger.positive(),

  totalFrames: SafeInteger.positive(),
  shotCount: SafeInteger.positive(),

  audio: RemotionNarrationSourceSchema,

  shots: z.array(
    RemotionCompositionShotSchema,
  ).min(1),

  /**
   * Exact verified word alignment.
   * Caption presentation will be implemented
   * separately in M7.4.
   */
  words: NarrationWordAlignmentSchema.shape.words,

  compositionHash: HashSchema,
}).strict();

export type RemotionComposition = z.infer<
  typeof RemotionCompositionSchema
>;

export type RemotionNarrationSource = z.infer<
  typeof RemotionNarrationSourceSchema
>;

export interface CreateRemotionCompositionInput {
  visual: AudioAlignedVisualPackage;
  alignment: NarrationWordAlignment;
  audio: RemotionNarrationSource;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function verifyHash(
  value: Record<string, unknown>,
  hashField: string,
): void {
  const actual = value[hashField];

  const payload = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== hashField,
    ),
  );

  if (actual !== hash(payload)) {
    throw new Error(
      `M7 package integrity mismatch: ${hashField}`,
    );
  }
}

export function createRemotionComposition(
  input: CreateRemotionCompositionInput,
): RemotionComposition {
  const visual =
    AudioAlignedVisualPackageSchema.parse(
      input.visual,
    );

  const alignment =
    NarrationWordAlignmentSchema.parse(
      input.alignment,
    );

  const audio =
    RemotionNarrationSourceSchema.parse(
      input.audio,
    );

  // Every input must be verified before it becomes
  // authoritative for a rendered composition.
  verifyHash(
    visual as Record<string, unknown>,
    "audioAlignedVisualHash",
  );

  verifyHash(
    visual.visual as Record<string, unknown>,
    "visualPackageHash",
  );

  verifyHash(
    alignment as Record<string, unknown>,
    "alignmentHash",
  );

  if (!path.isAbsolute(audio.path)) {
    throw new Error(
      "M7 narration path must be absolute",
    );
  }

  if (
    visual.jobId !== alignment.jobId ||
    visual.visual.jobId !== alignment.jobId
  ) {
    throw new Error(
      "M7 composition job identity mismatch",
    );
  }

  if (
    visual.audioSha256 !== audio.sha256 ||
    alignment.audioSha256 !== audio.sha256
  ) {
    throw new Error(
      "M7 composition audio identity mismatch",
    );
  }

  if (
    alignment.sampleRate !== audio.sampleRate ||
    alignment.sampleFrames !== audio.sampleFrames
  ) {
    throw new Error(
      "M7 composition WAV duration mismatch",
    );
  }

  if (
    visual.scriptHash !== alignment.scriptHash ||
    visual.alignmentHash !== alignment.alignmentHash
  ) {
    throw new Error(
      "M7 composition alignment identity mismatch",
    );
  }

  const renderer = visual.visual;

  if (
    renderer.shotCount !== renderer.shots.length ||
    renderer.totalFrames < 1
  ) {
    throw new Error(
      "M7 composition shot coverage mismatch",
    );
  }

  // The exact video duration must follow the
  // verified M6 final-frame ceiling policy.
  const expectedFrames =
    (
      BigInt(audio.sampleFrames) *
        BigInt(renderer.fps) +
      BigInt(audio.sampleRate) - 1n
    ) / BigInt(audio.sampleRate);

  if (
    expectedFrames !==
    BigInt(renderer.totalFrames)
  ) {
    throw new Error(
      "M7 composition video/audio duration mismatch",
    );
  }

  let previousEndFrame = 0;

  for (
    let index = 0;
    index < renderer.shots.length;
    index++
  ) {
    const shot = renderer.shots[index]!;

    if (
      shot.shotIndex !== index ||
      shot.startFrame !== previousEndFrame ||
      shot.endFrameExclusive <= shot.startFrame ||
      shot.durationFrames !==
        shot.endFrameExclusive - shot.startFrame ||
      shot.endFrameExclusive > renderer.totalFrames
    ) {
      throw new Error(
        `M7 composition shot continuity mismatch at ${index}`,
      );
    }

    if (!path.isAbsolute(shot.assetPath)) {
      throw new Error(
        `M7 shot asset path must be absolute: ${shot.shotId}`,
      );
    }

    previousEndFrame =
      shot.endFrameExclusive;
  }

  if (
    previousEndFrame !== renderer.totalFrames
  ) {
    throw new Error(
      "M7 composition does not cover all frames",
    );
  }

  let previousWordEnd = 0;

  for (const [index, word] of
    alignment.words.entries()) {
    const wordIdx = word.index ?? word.tokenIndex;
    if (
      wordIdx !== index ||
      word.startSample < previousWordEnd ||
      word.endSampleExclusive < word.startSample ||
      word.endSampleExclusive > audio.sampleFrames
    ) {
      throw new Error(
        `M7 caption alignment invalid at ${index}`,
      );
    }

    previousWordEnd = word.endSampleExclusive;
  }

  const payload = {
    version: 1 as const,
    compositionId: "YouCreatorNarratedV1" as const,

    jobId: visual.jobId,

    productionPackageHash:
      renderer.productionPackageHash,

    m6VisualHash:
      visual.audioAlignedVisualHash,

    visualPackageHash:
      renderer.visualPackageHash,

    framePlanHash: visual.framePlanHash,

    scriptHash: visual.scriptHash,
    alignmentHash: alignment.alignmentHash,

    audioSha256: audio.sha256,

    fps: renderer.fps,
    width: renderer.frameWidth,
    height: renderer.frameHeight,

    totalFrames: renderer.totalFrames,
    shotCount: renderer.shotCount,

    audio,
    shots: renderer.shots,
    words: alignment.words,
  };

  return RemotionCompositionSchema.parse({
    ...payload,
    compositionHash: hash(payload),
  });
}

export function verifyRemotionComposition(
  candidate: unknown,
  input: CreateRemotionCompositionInput,
): RemotionComposition {
  const saved =
    RemotionCompositionSchema.parse(
      candidate,
    );

  const rebuilt =
    createRemotionComposition(input);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(rebuilt)
  ) {
    throw new Error(
      "M7 composition canonical reconstruction mismatch",
    );
  }

  return saved;
}
