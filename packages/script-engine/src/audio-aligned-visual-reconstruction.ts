import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ShotMediaBindingPackageSchema,
  type ShotMediaBindingPackage,
} from "./shot-media-binding.js";

import {
  createShotMotionPlan,
} from "./shot-motion-plan.js";

import {
  createShotFrameGeometryFromFrames,
} from "./shot-frame-geometry.js";

import {
  createRendererReadyVisualPackage,
  RendererReadyVisualPackageSchema,
  type RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import {
  AudioAlignedFramePlanSchema,
  type AudioAlignedFramePlan,
} from "./audio-aligned-frame-plan.js";

import {
  AudioAlignedVisualContractSchema,
  createAudioAlignedVisualContract,
  type AudioAlignedVisualContract,
} from "./audio-aligned-visual-contract.js";

import type {
  MediaRenderReadinessOptions,
} from "./media-render-readiness.js";

const HashSchema = z.string()
  .regex(/^[a-f0-9]{64}$/);

export const AudioAlignedVisualPackageSchema =
  z.object({
    version: z.literal(1),

    jobId: z.string().min(1),

    contractHash: HashSchema,
    m5VisualPackageHash: HashSchema,
    framePlanHash: HashSchema,

    audioSha256: HashSchema,
    scriptHash: HashSchema,
    alignmentHash: HashSchema,

    motionPackageHash: HashSchema,
    geometryPackageHash: HashSchema,

    visual: RendererReadyVisualPackageSchema,

    audioAlignedVisualHash: HashSchema,
  }).strict();

export type AudioAlignedVisualPackage = z.infer<
  typeof AudioAlignedVisualPackageSchema
>;

export interface ReconstructAudioAlignedVisualInput {
  /**
   * From the trusted M3/M4/M5 verification path.
   */
  bindings: ShotMediaBindingPackage;

  /**
   * Existing M5 visual package.
   * This object remains unchanged.
   */
  m5Visual: RendererReadyVisualPackage;

  /**
   * From verified M6 narration alignment.
   */
  framePlan: AudioAlignedFramePlan;

  /**
   * Filesystem/media-readiness policy used by
   * the existing native M5 preparation path.
   */
  readinessOptions?: MediaRenderReadinessOptions;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

/**
 * Confirms the separately supplied media bindings
 * are the same ones represented by the M5 visual.
 *
 * This is an identity check, not a replacement
 * for native M4 rights/media-byte verification.
 */
function verifyM5BindingParity(
  bindings: ShotMediaBindingPackage,
  visual: RendererReadyVisualPackage,
): void {
  if (
    bindings.jobId !== visual.jobId ||
    bindings.productionPackageHash !==
      visual.productionPackageHash ||
    bindings.mediaManifestHash !==
      visual.mediaManifestHash ||
    bindings.bindingPackageHash !==
      visual.bindingPackageHash ||
    bindings.bindings.length !== visual.shotCount
  ) {
    throw new Error(
      "M6 reconstruction M5 binding identity mismatch",
    );
  }

  for (
    let index = 0;
    index < bindings.bindings.length;
    index++
  ) {
    const binding = bindings.bindings[index]!;
    const shot = visual.shots[index];

    if (
      !shot ||
      binding.shotId !== shot.shotId ||
      binding.shotIndex !== index ||
      shot.shotIndex !== index ||
      binding.bindingHash !== shot.bindingHash ||
      binding.asset.id !== shot.assetId ||
      binding.asset.sha256 !== shot.assetSha256 ||
      binding.asset.localPath !== shot.assetPath ||
      binding.asset.width !== shot.sourceWidth ||
      binding.asset.height !== shot.sourceHeight
    ) {
      throw new Error(
        `M6 reconstruction media identity mismatch at ${index}`,
      );
    }
  }
}

function verifyOutputParity(
  visual: RendererReadyVisualPackage,
  contract: AudioAlignedVisualContract,
  oldVisual: RendererReadyVisualPackage,
): void {
  if (
    visual.jobId !== contract.jobId ||
    visual.productionPackageHash !==
      contract.productionPackageHash ||
    visual.mediaManifestHash !==
      contract.mediaManifestHash ||
    visual.fps !== contract.fps ||
    visual.frameWidth !== contract.frameWidth ||
    visual.frameHeight !== contract.frameHeight ||
    visual.totalFrames !== contract.totalFrames ||
    visual.shotCount !== contract.shotCount
  ) {
    throw new Error(
      "M6 reconstruction output package mismatch",
    );
  }

  for (
    let index = 0;
    index < visual.shots.length;
    index++
  ) {
    const shot = visual.shots[index]!;
    const expected = contract.shots[index]!;
    const original = oldVisual.shots[index]!;

    if (
      shot.shotId !== expected.shotId ||
      shot.shotIndex !== index ||
      shot.startFrame !== expected.startFrame ||
      shot.endFrameExclusive !==
        expected.endFrameExclusive ||
      shot.durationFrames !==
        expected.durationFrames ||
      shot.assetId !== expected.assetId ||
      shot.assetSha256 !== expected.assetSha256 ||
      shot.bindingHash !== expected.bindingHash ||
      shot.assetPath !== original.assetPath ||
      shot.sourceWidth !== expected.sourceWidth ||
      shot.sourceHeight !== expected.sourceHeight
    ) {
      throw new Error(
        `M6 reconstruction output shot mismatch at ${index}`,
      );
    }
  }
}

export async function reconstructAudioAlignedVisual(
  input: ReconstructAudioAlignedVisualInput,
): Promise<AudioAlignedVisualPackage> {
  const bindings =
    ShotMediaBindingPackageSchema.parse(
      input.bindings,
    );

  const framePlan =
    AudioAlignedFramePlanSchema.parse(
      input.framePlan,
    );

  const m5Visual =
    RendererReadyVisualPackageSchema.parse(
      input.m5Visual,
    );

  const contract =
    AudioAlignedVisualContractSchema.parse(
      createAudioAlignedVisualContract({
        visual: m5Visual,
        framePlan,
      }),
    );

  verifyM5BindingParity(
    bindings,
    m5Visual,
  );

  // Motion selection is based on actual M6 shot
  // duration rather than M3's estimated duration.
  //
  // This may change a previously animated shot
  // into a static shot if its real duration is
  // shorter than 2 seconds, as defined by M5.
  const motion = createShotMotionPlan({
    bindings,

    durations: framePlan.shots.map(
      (shot) => ({
        shotId: shot.shotId,
        durationSeconds:
          shot.durationFrames / framePlan.fps,
      }),
    ),

    frameWidth: m5Visual.frameWidth,
    frameHeight: m5Visual.frameHeight,
  });

  // Uses the exact-frame entry point added to
  // the existing M5 geometry module.
  const geometry =
    createShotFrameGeometryFromFrames({
      motionPlan: motion,
      frameTimings: framePlan.shots.map(
        (shot) => ({
          shotId: shot.shotId,
          shotIndex: shot.shotIndex,
          startFrame: shot.startFrame,
          endFrameExclusive:
            shot.endFrameExclusive,
          durationFrames:
            shot.durationFrames,
        }),
      ),

      fps: framePlan.fps,
      totalFrames:
        framePlan.totalFrames,
    });

  // Reuses real image decoding, dimensions,
  // binding identities, and readiness checks.
  const visual =
    await createRendererReadyVisualPackage({
      bindings,
      motion,
      geometry,
      readinessOptions:
        input.readinessOptions,
    });

  verifyOutputParity(
    visual,
    contract,
    m5Visual,
  );

  const payload = {
    version: 1 as const,

    jobId: contract.jobId,

    contractHash: contract.contractHash,
    m5VisualPackageHash:
      contract.m5VisualPackageHash,
    framePlanHash:
      contract.m6FramePlanHash,

    audioSha256:
      contract.audioSha256,

    scriptHash:
      contract.scriptHash,

    alignmentHash:
      contract.alignmentHash,

    motionPackageHash:
      motion.motionPackageHash,

    geometryPackageHash:
      geometry.geometryPackageHash,

    visual,
  };

  return AudioAlignedVisualPackageSchema.parse({
    ...payload,

    audioAlignedVisualHash:
      hash(payload),
  });
}

/**
 * Reconstructs the candidate from the current
 * authoritative inputs and checks every field.
 *
 * Native integration must reload/verify M3, M4,
 * M5 and M6 sources before calling this.
 */
export async function verifyAudioAlignedVisual(
  candidate: unknown,
  input: ReconstructAudioAlignedVisualInput,
): Promise<AudioAlignedVisualPackage> {
  const saved =
    AudioAlignedVisualPackageSchema.parse(
      candidate,
    );

  const rebuilt =
    await reconstructAudioAlignedVisual(
      input,
    );

  if (
    JSON.stringify(saved) !==
    JSON.stringify(rebuilt)
  ) {
    throw new Error(
      "M6 audio-aligned visual reconstruction mismatch",
    );
  }

  return saved;
}
