import { z } from "zod";

import type {
  MediaResolutionRequest,
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  createShotMediaBindings,
  ShotMediaBindingPackageSchema,
  type ShotMediaBindingPackage,
} from "./shot-media-binding.js";

import {
  createShotMotionPlan,
  ShotMotionPackageSchema,
  type ShotMotionPackage,
} from "./shot-motion-plan.js";

import {
  createShotFrameGeometry,
  ShotFrameGeometryPackageSchema,
  type CanonicalShotTiming,
  type ShotFrameGeometryPackage,
} from "./shot-frame-geometry.js";

import {
  createRendererReadyVisualPackage,
  RendererReadyVisualPackageSchema,
  type RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import type {
  MediaRenderReadinessOptions,
} from "./media-render-readiness.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface AuthoritativeVisualInputs {
  /**
   * These inputs MUST be supplied by a caller that
   * has independently verified persisted M3 and M4.
   *
   * This function does not authenticate their origin.
   */
  request: MediaResolutionRequest;
  report: MediaResolutionReport;

  productionPackageHash: string;
  mediaManifestHash: string;

  timings: CanonicalShotTiming[];

  fps?: number;
  frameWidth?: number;
  frameHeight?: number;

  readinessOptions?: MediaRenderReadinessOptions;
}

export interface ExpectedVisualPackages {
  bindings?: ShotMediaBindingPackage;
  motion?: ShotMotionPackage;
  geometry?: ShotFrameGeometryPackage;
  visual?: RendererReadyVisualPackage;
}

export interface AuthoritativeVisualResult {
  bindings: ShotMediaBindingPackage;
  motion: ShotMotionPackage;
  geometry: ShotFrameGeometryPackage;
  visual: RendererReadyVisualPackage;
}

/**
 * Compare complete validated package contents.
 *
 * Merely recomputing the submitted package's own
 * hash would not establish canonical origin.
 */
function assertCanonical<T>(
  name: string,
  expected: T | undefined,
  canonical: T,
): void {
  if (expected === undefined) {
    return;
  }

  if (
    JSON.stringify(expected) !==
    JSON.stringify(canonical)
  ) {
    throw new Error(
      `Noncanonical visual package: ${name}`,
    );
  }
}

/**
 * Rebuilds all visual planning layers from the
 * supplied verified-source inputs.
 *
 * Importantly, this never adopts an existing
 * camera plan, crop, or frame range as authority.
 */
export async function reconstructAuthoritativeVisualPackage(
  input: AuthoritativeVisualInputs,
  expected: ExpectedVisualPackages = {},
): Promise<AuthoritativeVisualResult> {
  const productionPackageHash =
    HashSchema.parse(input.productionPackageHash);

  const mediaManifestHash =
    HashSchema.parse(input.mediaManifestHash);

  const bindings = createShotMediaBindings({
    request: input.request,
    report: input.report,
    productionPackageHash,
    mediaManifestHash,
  });

  const durations = input.timings.map(
    (timing) => ({
      shotId: timing.shotId,
      durationSeconds:
        timing.endSeconds - timing.startSeconds,
    }),
  );

  const motion = createShotMotionPlan({
    bindings,
    durations,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
  });

  const geometry = createShotFrameGeometry({
    motionPlan: motion,
    timings: input.timings,
    fps: input.fps,
  });

  // Full source-byte and pixel-decode verification
  // is still performed by this builder.
  const visual = await createRendererReadyVisualPackage({
    bindings,
    motion,
    geometry,
    readinessOptions: input.readinessOptions,
  });

  // Parse submitted packages first: reject malformed
  // records before comparing their full contents.
  assertCanonical(
    "bindings",
    expected.bindings === undefined
      ? undefined
      : ShotMediaBindingPackageSchema.parse(
          expected.bindings,
        ),
    bindings,
  );

  assertCanonical(
    "motion",
    expected.motion === undefined
      ? undefined
      : ShotMotionPackageSchema.parse(
          expected.motion,
        ),
    motion,
  );

  assertCanonical(
    "geometry",
    expected.geometry === undefined
      ? undefined
      : ShotFrameGeometryPackageSchema.parse(
          expected.geometry,
        ),
    geometry,
  );

  assertCanonical(
    "visual",
    expected.visual === undefined
      ? undefined
      : RendererReadyVisualPackageSchema.parse(
          expected.visual,
        ),
    visual,
  );

  return {
    bindings,
    motion,
    geometry,
    visual,
  };
}
