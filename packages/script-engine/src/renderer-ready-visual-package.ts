import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ShotMediaBindingPackageSchema,
  type ShotMediaBindingPackage,
} from "./shot-media-binding.js";

import {
  ShotMotionPackageSchema,
  type ShotMotionPackage,
} from "./shot-motion-plan.js";

import {
  ShotFrameGeometryPackageSchema,
  type ShotFrameGeometryPackage,
} from "./shot-frame-geometry.js";

import {
  verifyImageRenderReadiness,
  type MediaRenderReadinessOptions,
} from "./media-render-readiness.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const RendererReadyVisualShotSchema = z.object({
  version: z.literal(1),

  shotId: z.string().min(1),
  shotIndex: z.number().int().nonnegative(),

  bindingHash: HashSchema,
  assetSha256: HashSchema,

  assetId: z.string().min(1),
  assetPath: z.string().min(1),

  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),

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

  startCrop: z.object({
    left: z.number().finite().nonnegative(),
    top: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }).strict().nullable(),

  endCrop: z.object({
    left: z.number().finite().nonnegative(),
    top: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }).strict().nullable(),
}).strict();

export type RendererReadyVisualShot = z.infer<
  typeof RendererReadyVisualShotSchema
>;

export const RendererReadyVisualPackageSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),

  productionPackageHash: HashSchema,
  mediaManifestHash: HashSchema,
  bindingPackageHash: HashSchema,
  motionPackageHash: HashSchema,
  geometryPackageHash: HashSchema,

  fps: z.number().int().positive(),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),

  totalFrames: z.number().int().positive(),
  shotCount: z.number().int().positive(),

  shots: z.array(
    RendererReadyVisualShotSchema,
  ).min(1),

  visualPackageHash: HashSchema,
}).strict();

export type RendererReadyVisualPackage = z.infer<
  typeof RendererReadyVisualPackageSchema
>;

export interface CreateRendererReadyVisualPackageInput {
  bindings: ShotMediaBindingPackage;
  motion: ShotMotionPackage;
  geometry: ShotFrameGeometryPackage;

  readinessOptions?: MediaRenderReadinessOptions;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function verifyPackageHash(
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
      `Package integrity mismatch: ${hashField}`,
    );
  }
}

export async function createRendererReadyVisualPackage(
  input: CreateRendererReadyVisualPackageInput,
): Promise<RendererReadyVisualPackage> {
  const bindings =
    ShotMediaBindingPackageSchema.parse(
      input.bindings,
    );

  const motion =
    ShotMotionPackageSchema.parse(
      input.motion,
    );

  const geometry =
    ShotFrameGeometryPackageSchema.parse(
      input.geometry,
    );

  verifyPackageHash(
    bindings as Record<string, unknown>,
    "bindingPackageHash",
  );

  verifyPackageHash(
    motion as Record<string, unknown>,
    "motionPackageHash",
  );

  verifyPackageHash(
    geometry as Record<string, unknown>,
    "geometryPackageHash",
  );

  if (
    bindings.jobId !== motion.jobId ||
    bindings.jobId !== geometry.jobId
  ) {
    throw new Error(
      "Visual package job identity mismatch",
    );
  }

  if (
    motion.bindingPackageHash !==
      bindings.bindingPackageHash ||
    geometry.motionPackageHash !==
      motion.motionPackageHash
  ) {
    throw new Error(
      "Visual package dependency hash mismatch",
    );
  }

  const count = bindings.bindings.length;

  if (
    count !== bindings.shotCount ||
    count !== motion.shots.length ||
    count !== geometry.shots.length
  ) {
    throw new Error(
      "Visual package shot coverage mismatch",
    );
  }

  if (
    motion.frameWidth !== geometry.frameWidth ||
    motion.frameHeight !== geometry.frameHeight
  ) {
    throw new Error(
      "Visual package frame dimensions mismatch",
    );
  }

  let previousEndFrame = 0;

  const shots: RendererReadyVisualShot[] = [];

  for (let index = 0; index < count; index++) {
    const binding = bindings.bindings[index]!;
    const camera = motion.shots[index]!;
    const frames = geometry.shots[index]!;

    if (
      binding.shotId !== camera.shotId ||
      binding.shotId !== frames.shotId ||
      binding.shotIndex !== index ||
      camera.shotIndex !== index ||
      frames.shotIndex !== index
    ) {
      throw new Error(
        `Visual shot identity mismatch at index ${index}`,
      );
    }

    if (
      binding.bindingHash !== camera.bindingHash ||
      binding.bindingHash !== frames.bindingHash ||
      binding.asset.sha256 !== camera.assetSha256 ||
      binding.asset.sha256 !== frames.assetSha256
    ) {
      throw new Error(
        `Visual shot asset identity mismatch: ${binding.shotId}`,
      );
    }

    if (
      binding.asset.width !== camera.sourceWidth ||
      binding.asset.height !== camera.sourceHeight ||
      binding.asset.width !== frames.sourceWidth ||
      binding.asset.height !== frames.sourceHeight ||
      camera.frameWidth !== geometry.frameWidth ||
      camera.frameHeight !== geometry.frameHeight ||
      frames.frameWidth !== geometry.frameWidth ||
      frames.frameHeight !== geometry.frameHeight
    ) {
      throw new Error(
        `Visual shot dimension mismatch: ${binding.shotId}`,
      );
    }

    if (
      camera.fit !== frames.fit ||
      camera.motion !== frames.motion
    ) {
      throw new Error(
        `Visual shot motion mismatch: ${binding.shotId}`,
      );
    }

    if (
      frames.startFrame !== previousEndFrame ||
      frames.endFrameExclusive <= frames.startFrame ||
      frames.durationFrames !==
        frames.endFrameExclusive - frames.startFrame
    ) {
      throw new Error(
        `Visual shot frame continuity mismatch: ${binding.shotId}`,
      );
    }

    if (
      (frames.fit === "cover" &&
        (!frames.startCrop || !frames.endCrop)) ||
      (frames.fit === "contain" &&
        (frames.startCrop !== null ||
          frames.endCrop !== null))
    ) {
      throw new Error(
        `Visual shot crop configuration mismatch: ${binding.shotId}`,
      );
    }

    // Do not trust an externally supplied readiness report.
    // Decode and verify the actual source file.
    const readiness =
      await verifyImageRenderReadiness(
        binding.asset,
        input.readinessOptions,
      );

    if (!readiness.ready) {
      throw new Error(
        `Image is not renderer-ready: ${binding.shotId}; ` +
          readiness.issues.map(
            (entry) => entry.code,
          ).join(", "),
      );
    }

    shots.push(
      RendererReadyVisualShotSchema.parse({
        version: 1,

        shotId: binding.shotId,
        shotIndex: index,

        bindingHash: binding.bindingHash,
        assetSha256: binding.asset.sha256,

        assetId: binding.asset.id,
        assetPath: binding.asset.localPath,

        sourceWidth: camera.sourceWidth,
        sourceHeight: camera.sourceHeight,

        startFrame: frames.startFrame,
        endFrameExclusive:
          frames.endFrameExclusive,
        durationFrames: frames.durationFrames,

        fit: camera.fit,
        motion: camera.motion,

        startCrop: frames.startCrop,
        endCrop: frames.endCrop,
      }),
    );

    previousEndFrame =
      frames.endFrameExclusive;
  }

  if (
    previousEndFrame !== geometry.totalFrames
  ) {
    throw new Error(
      "Visual package total frame mismatch",
    );
  }

  const payload = {
    version: 1 as const,
    jobId: bindings.jobId,

    productionPackageHash:
      bindings.productionPackageHash,
    mediaManifestHash:
      bindings.mediaManifestHash,
    bindingPackageHash:
      bindings.bindingPackageHash,
    motionPackageHash:
      motion.motionPackageHash,
    geometryPackageHash:
      geometry.geometryPackageHash,

    fps: geometry.fps,

    frameWidth: geometry.frameWidth,
    frameHeight: geometry.frameHeight,

    totalFrames: geometry.totalFrames,
    shotCount: shots.length,
    shots,
  };

  return RendererReadyVisualPackageSchema.parse({
    ...payload,
    visualPackageHash: hash(payload),
  });
}
