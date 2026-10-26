import { createHash } from "node:crypto";
import { z } from "zod";

import {
  RendererReadyVisualPackageSchema,
  type RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import {
  AudioAlignedFramePlanSchema,
  type AudioAlignedFramePlan,
} from "./audio-aligned-frame-plan.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const AudioAlignedVisualShotContractSchema =
  z.object({
    version: z.literal(1),

    shotId: z.string().min(1),
    shotIndex: z.number().int().nonnegative(),

    assetId: z.string().min(1),
    assetSha256: HashSchema,
    bindingHash: HashSchema,

    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),

    startFrame: z.number().int().nonnegative(),
    endFrameExclusive: z.number().int().positive(),
    durationFrames: z.number().int().positive(),
  }).strict();

export const AudioAlignedVisualContractSchema =
  z.object({
    version: z.literal(1),

    jobId: z.string().min(1),

    productionPackageHash: HashSchema,
    mediaManifestHash: HashSchema,

    m5VisualPackageHash: HashSchema,
    m6FramePlanHash: HashSchema,

    audioSha256: HashSchema,
    scriptHash: HashSchema,
    alignmentHash: HashSchema,

    fps: z.number().int().positive(),
    frameWidth: z.number().int().positive(),
    frameHeight: z.number().int().positive(),

    totalFrames: z.number().int().positive(),
    shotCount: z.number().int().positive(),

    shots: z.array(
      AudioAlignedVisualShotContractSchema,
    ).min(1),

    contractHash: HashSchema,
  }).strict();

export type AudioAlignedVisualContract = z.infer<
  typeof AudioAlignedVisualContractSchema
>;

export interface CreateAudioAlignedVisualContractInput {
  visual: RendererReadyVisualPackage;
  framePlan: AudioAlignedFramePlan;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function verifyM5Hash(
  visual: RendererReadyVisualPackage,
): void {
  const {
    visualPackageHash,
    ...payload
  } = visual;

  if (sha256(payload) !== visualPackageHash) {
    throw new Error(
      "M6 visual contract M5 integrity mismatch",
    );
  }
}

function verifyM6Hash(
  plan: AudioAlignedFramePlan,
): void {
  const {
    framePlanHash,
    ...payload
  } = plan;

  if (sha256(payload) !== framePlanHash) {
    throw new Error(
      "M6 visual contract frame plan integrity mismatch",
    );
  }
}

export function createAudioAlignedVisualContract(
  input: CreateAudioAlignedVisualContractInput,
): AudioAlignedVisualContract {
  const visual =
    RendererReadyVisualPackageSchema.parse(
      input.visual,
    );

  const framePlan =
    AudioAlignedFramePlanSchema.parse(
      input.framePlan,
    );

  verifyM5Hash(visual);
  verifyM6Hash(framePlan);

  if (
    visual.jobId !== framePlan.jobId
  ) {
    throw new Error(
      "M6 visual contract job identity mismatch",
    );
  }

  if (
    visual.productionPackageHash !==
    framePlan.productionPackageHash
  ) {
    throw new Error(
      "M6 visual contract M3 identity mismatch",
    );
  }

  if (
    visual.fps !== framePlan.fps
  ) {
    throw new Error(
      "M6 visual contract FPS mismatch",
    );
  }

  if (
    visual.shotCount !== framePlan.shotCount ||
    visual.shots.length !== framePlan.shots.length
  ) {
    throw new Error(
      "M6 visual contract shot count mismatch",
    );
  }

  // M5's media identities are authoritative.
  // M6's frame boundaries are authoritative.
  const shots = visual.shots.map(
    (m5Shot, index) => {
      const m6Shot = framePlan.shots[index];

      if (
        !m6Shot ||
        m5Shot.shotIndex !== index ||
        m6Shot.shotIndex !== index ||
        m5Shot.shotId !== m6Shot.shotId
      ) {
        throw new Error(
          `M6 visual contract shot identity mismatch at ${index}`,
        );
      }

      if (
        m6Shot.endFrameExclusive -
          m6Shot.startFrame !==
        m6Shot.durationFrames
      ) {
        throw new Error(
          `M6 visual contract duration mismatch at ${index}`,
        );
      }

      return AudioAlignedVisualShotContractSchema.parse({
        version: 1,

        shotId: m5Shot.shotId,
        shotIndex: index,

        assetId: m5Shot.assetId,
        assetSha256: m5Shot.assetSha256,
        bindingHash: m5Shot.bindingHash,

        sourceWidth: m5Shot.sourceWidth,
        sourceHeight: m5Shot.sourceHeight,

        startFrame: m6Shot.startFrame,
        endFrameExclusive:
          m6Shot.endFrameExclusive,
        durationFrames:
          m6Shot.durationFrames,
      });
    },
  );

  let previousEndFrame = 0;

  for (const shot of shots) {
    if (
      shot.startFrame !== previousEndFrame ||
      shot.endFrameExclusive <=
        shot.startFrame
    ) {
      throw new Error(
        "M6 visual contract frame continuity mismatch",
      );
    }

    previousEndFrame =
      shot.endFrameExclusive;
  }

  if (
    previousEndFrame !==
    framePlan.totalFrames
  ) {
    throw new Error(
      "M6 visual contract total frame mismatch",
    );
  }

  const payload = {
    version: 1 as const,

    jobId: visual.jobId,

    productionPackageHash:
      visual.productionPackageHash,

    mediaManifestHash:
      visual.mediaManifestHash,

    m5VisualPackageHash:
      visual.visualPackageHash,

    m6FramePlanHash:
      framePlan.framePlanHash,

    audioSha256:
      framePlan.audioSha256,

    scriptHash:
      framePlan.scriptHash,

    alignmentHash:
      framePlan.alignmentHash,

    fps: framePlan.fps,

    frameWidth:
      visual.frameWidth,

    frameHeight:
      visual.frameHeight,

    totalFrames:
      framePlan.totalFrames,

    shotCount: shots.length,

    shots,
  };

  return AudioAlignedVisualContractSchema.parse({
    ...payload,
    contractHash: sha256(payload),
  });
}

export function verifyAudioAlignedVisualContract(
  candidate: unknown,
  input: CreateAudioAlignedVisualContractInput,
): AudioAlignedVisualContract {
  const saved =
    AudioAlignedVisualContractSchema.parse(
      candidate,
    );

  const canonical =
    createAudioAlignedVisualContract(
      input,
    );

  if (
    JSON.stringify(saved) !==
    JSON.stringify(canonical)
  ) {
    throw new Error(
      "M6 visual contract canonical reconstruction mismatch",
    );
  }

  return saved;
}
