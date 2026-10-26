import {
  createShotNarrationAnchors,
  type CreateShotNarrationAnchorsInput,
} from "./shot-narration-anchors.js";

import {
  createAudioSampleShotTimeline,
} from "./audio-sample-shot-timeline.js";

import {
  createAudioAlignedFramePlan,
} from "./audio-aligned-frame-plan.js";

import {
  createAudioAlignedVisualContract,
} from "./audio-aligned-visual-contract.js";

import {
  reconstructAudioAlignedVisual,
  type AudioAlignedVisualPackage,
} from "./audio-aligned-visual-reconstruction.js";

import {
  PersistentAudioAlignedVisualStore,
  type AudioAlignedVisualReconstructionPort,
} from "./persistent-audio-aligned-visual.js";

import type {
  ShotMediaBindingPackage,
} from "./shot-media-binding.js";

import type {
  RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import type {
  MediaRenderReadinessOptions,
} from "./media-render-readiness.js";

import {
  createNativeAudioAlignedVisualStage,
} from "./audio-aligned-visual-stage.js";

/**
 * The native loader is a trusted boundary.
 *
 * Its implementation MUST load persisted artifacts
 * using the repository's existing authoritative
 * verifiers. It must not synthesize new audio,
 * acquire media, or infer narration boundaries.
 */
export interface VerifiedNativeM6Sources {
  bindings: ShotMediaBindingPackage;
  m5Visual: RendererReadyVisualPackage;

  anchoring: CreateShotNarrationAnchorsInput;

  authoritativeShotIds: readonly string[];

  fps: number;
  readinessOptions?: MediaRenderReadinessOptions;
}

export interface VerifiedNativeM6SourceLoader {
  load(jobId: string): Promise<VerifiedNativeM6Sources>;
}

function assertNativeIdentity(
  jobId: string,
  source: VerifiedNativeM6Sources,
): void {
  if (
    !jobId.trim() ||
    source.bindings.jobId !== jobId ||
    source.m5Visual.jobId !== jobId ||
    source.anchoring.jobId !== jobId ||
    source.anchoring.alignment.jobId !== jobId
  ) {
    throw new Error(
      "Native M6 job identity mismatch",
    );
  }

  const productionHash =
    source.bindings.productionPackageHash;

  if (
    source.m5Visual.productionPackageHash !==
      productionHash ||
    source.anchoring.productionPackageHash !==
      productionHash
  ) {
    throw new Error(
      "Native M6 M3 identity mismatch",
    );
  }

  if (
    source.bindings.mediaManifestHash !==
      source.m5Visual.mediaManifestHash ||
    source.bindings.bindingPackageHash !==
      source.m5Visual.bindingPackageHash
  ) {
    throw new Error(
      "Native M6 media dependency mismatch",
    );
  }

  if (
    !Number.isSafeInteger(source.fps) ||
    source.fps < 1 ||
    source.fps > 120 ||
    source.fps !== source.m5Visual.fps
  ) {
    throw new Error(
      "Native M6 frame rate mismatch",
    );
  }

  const count = source.authoritativeShotIds.length;

  if (
    count === 0 ||
    count !== source.bindings.bindings.length ||
    count !== source.m5Visual.shots.length ||
    count !== source.anchoring.shots.length
  ) {
    throw new Error(
      "Native M6 shot coverage mismatch",
    );
  }

  const uniqueIds = new Set(
    source.authoritativeShotIds,
  );

  if (uniqueIds.size !== count) {
    throw new Error(
      "Native M6 duplicate M3 shot identity",
    );
  }

  for (let index = 0; index < count; index++) {
    const id = source.authoritativeShotIds[index];

    if (
      !id ||
      source.bindings.bindings[index]?.shotId !== id ||
      source.bindings.bindings[index]?.shotIndex !== index ||
      source.m5Visual.shots[index]?.shotId !== id ||
      source.m5Visual.shots[index]?.shotIndex !== index ||
      source.anchoring.shots[index]?.shotId !== id ||
      source.anchoring.shots[index]?.shotIndex !== index
    ) {
      throw new Error(
        `Native M6 authoritative shot mismatch at ${index}`,
      );
    }
  }
}

/**
 * Reconstruct from current verified inputs.
 *
 * This function does NOT:
 * - call Kokoro
 * - fetch image assets
 * - modify the M5 visual artifact
 * - estimate narration timing
 */
export async function reconstructNativeAudioAlignedVisual(
  jobId: string,
  loader: VerifiedNativeM6SourceLoader,
): Promise<AudioAlignedVisualPackage> {
  const source = await loader.load(jobId);

  assertNativeIdentity(jobId, source);

  // M6 Step 3A: canonical token attribution.
  const anchors = createShotNarrationAnchors(
    source.anchoring,
  );

  // M6 Step 3B: continuous WAV sample intervals.
  const sampleTimeline =
    createAudioSampleShotTimeline({
      anchors,
      authoritativeShotIds:
        source.authoritativeShotIds,
    });

  // M6 Step 3C: absolute audio-to-frame mapping.
  const framePlan =
    createAudioAlignedFramePlan({
      timeline: sampleTimeline,
      fps: source.fps,
      authoritativeShotIds:
        source.authoritativeShotIds,
    });

  // M6 Step 3D.1: immutable M5/M6 identity contract.
  createAudioAlignedVisualContract({
    visual: source.m5Visual,
    framePlan,
  });

  // M6 Step 3D.2: recalculate motion and geometry.
  return reconstructAudioAlignedVisual({
    bindings: source.bindings,
    m5Visual: source.m5Visual,
    framePlan,
    readinessOptions:
      source.readinessOptions,
  });
}

export interface NativeAudioAlignedVisualOptions {
  jobDirectory(jobId: string): string;
  sourceLoader: VerifiedNativeM6SourceLoader;
}

/**
 * Production factory.
 *
 * Reuses Step 3D.3 immutable persistence, which
 * reconstructs and compares artifacts on reuse.
 */
export function createNativeAudioAlignedVisualPipeline(
  options: NativeAudioAlignedVisualOptions,
) {
  const reconstruction:
    AudioAlignedVisualReconstructionPort = {
      reconstruct: (jobId) =>
        reconstructNativeAudioAlignedVisual(
          jobId,
          options.sourceLoader,
        ),
    };

  const store =
    new PersistentAudioAlignedVisualStore({
      jobDirectory: options.jobDirectory,
      reconstruction,
    });

  const stage = createNativeAudioAlignedVisualStage(
    store,
  );

  return {
    reconstruction,
    store,
    stage,
  };
}
