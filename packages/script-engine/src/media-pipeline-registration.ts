import {
  createHash,
} from "node:crypto";

import path from "node:path";

const MEDIA_STAGE_ID = "media";
const STORYBOARD_STAGE_ID = "storyboard";

export interface MediaPipelineRegistrationStage {
  readonly id: "media";
  readonly version: string;
  readonly dependencies: readonly string[];
}

export interface MediaPipelineRegistryPort<
  TStage extends MediaPipelineRegistrationStage,
> {
  register(stage: TStage): unknown;

  resolveOrder(): readonly (
    | string
    | { id: string }
  )[];
}

export interface RegisterMediaPipelineOptions<
  TStage extends MediaPipelineRegistrationStage,
> {
  registry: MediaPipelineRegistryPort<TStage>;
  stage: TStage;
}

function stageId(
  entry: string | { id: string },
): string {
  return typeof entry === "string"
    ? entry
    : entry.id;
}

/**
 * Register the existing native media stage with
 * the existing M1 pipeline registry.
 *
 * This function does not construct an executor
 * or create an alternative job lifecycle.
 */
export function registerMediaPipelineStage<
  TStage extends MediaPipelineRegistrationStage,
>(
  options: RegisterMediaPipelineOptions<TStage>,
): TStage {
  const { registry, stage } = options;

  if (stage.id !== MEDIA_STAGE_ID) {
    throw new Error(
      "Expected canonical media pipeline stage",
    );
  }

  if (!stage.version.trim()) {
    throw new Error(
      "Media pipeline stage version is required",
    );
  }

  if (
    stage.dependencies.length !== 1 ||
    stage.dependencies[0] !== STORYBOARD_STAGE_ID
  ) {
    throw new Error(
      "Media stage must depend on storyboard",
    );
  }

  const before = registry.resolveOrder()
    .map(stageId);

  if (!before.includes(STORYBOARD_STAGE_ID)) {
    throw new Error(
      "Storyboard stage must be registered before media",
    );
  }

  if (before.includes(MEDIA_STAGE_ID)) {
    throw new Error(
      "Media stage is already registered",
    );
  }

  registry.register(stage);

  const after = registry.resolveOrder()
    .map(stageId);

  const storyboardIndex = after.indexOf(
    STORYBOARD_STAGE_ID,
  );

  const mediaIndex = after.indexOf(
    MEDIA_STAGE_ID,
  );

  if (
    mediaIndex < 0 ||
    storyboardIndex < 0 ||
    storyboardIndex >= mediaIndex
  ) {
    throw new Error(
      "Media stage registration order is invalid",
    );
  }

  return stage;
}

/**
 * Resolve the ORIGINAL Step 12 media manifest path.
 *
 * PersistentMediaResolutionStage stores files under:
 *
 * storageRoot/media-resolution/<sha256(jobId)>/
 *
 * Do not silently move these files into jobDirectory.
 */
export function getMediaResolutionManifestPath(
  storageRoot: string,
  jobId: string,
): string {
  if (!storageRoot.trim()) {
    throw new Error(
      "Media storage root is required",
    );
  }

  if (!jobId.trim()) {
    throw new Error(
      "Media job ID is required",
    );
  }

  const jobKey = createHash("sha256")
    .update(jobId)
    .digest("hex");

  return path.join(
    path.resolve(storageRoot),
    "media-resolution",
    jobKey,
    "manifest.json",
  );
}

export function getMediaResolutionAttemptPath(
  storageRoot: string,
  jobId: string,
): string {
  return path.join(
    path.dirname(
      getMediaResolutionManifestPath(
        storageRoot,
        jobId,
      ),
    ),
    "attempt.json",
  );
}
