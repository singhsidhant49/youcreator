import type {
  VerifiedNativeM6SourceLoader,
  VerifiedNativeM6Sources,
} from "./native-audio-aligned-visual.js";

import type {
  CreateShotNarrationAnchorsInput,
} from "./shot-narration-anchors.js";

import type {
  ShotMediaBindingPackage,
} from "./shot-media-binding.js";

import type {
  RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

import type {
  MediaRenderReadinessOptions,
} from "./media-render-readiness.js";

/**
 * Each callback is an adapter to an existing
 * authoritative verification operation.
 *
 * No new synthesis or media acquisition is allowed.
 */
export interface NativeM6VerifiedArtifactReaders {
  loadVerifiedBindings(
    jobId: string,
  ): Promise<ShotMediaBindingPackage>;

  loadVerifiedM5Visual(
    jobId: string,
  ): Promise<RendererReadyVisualPackage>;

  loadVerifiedNarrationAnchoring(
    jobId: string,
  ): Promise<CreateShotNarrationAnchorsInput>;

  loadVerifiedM3ShotIds(
    jobId: string,
  ): Promise<readonly string[]>;

  verifyCurrentMediaRights(
    jobId: string,
  ): Promise<void>;

  fps: number;

  readinessOptions?: MediaRenderReadinessOptions;
}

export function createNativeM6SourceLoader(
  readers: NativeM6VerifiedArtifactReaders,
): VerifiedNativeM6SourceLoader {
  return {
    async load(jobId): Promise<VerifiedNativeM6Sources> {
      if (!jobId.trim()) {
        throw new Error(
          "Native M6 source loader requires job ID",
        );
      }

      // Rights must be checked on every execution
      // AND on every checkpoint validation.
      await readers.verifyCurrentMediaRights(jobId);

      const [
        bindings,
        m5Visual,
        anchoring,
        authoritativeShotIds,
      ] = await Promise.all([
        readers.loadVerifiedBindings(jobId),
        readers.loadVerifiedM5Visual(jobId),
        readers.loadVerifiedNarrationAnchoring(jobId),
        readers.loadVerifiedM3ShotIds(jobId),
      ]);

      return {
        bindings,
        m5Visual,
        anchoring,
        authoritativeShotIds,
        fps: m5Visual.fps ?? readers.fps,
        readinessOptions:
          readers.readinessOptions,
      };
    },
  };
}
