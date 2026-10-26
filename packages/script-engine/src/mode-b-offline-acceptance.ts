import {
  PipelineRegistry,
  type PipelineContext,
  type PipelineStage,
} from "@youcreator/core";

import {
  MediaAcquirer,
} from "./media-acquirer.js";

import {
  MediaObjectStore,
} from "./media-object-store.js";

import {
  MediaUsageRightsStore,
} from "./media-usage-rights-store.js";

import {
  createRegisteredModeBMediaStage,
} from "./registered-mode-b-media-stage.js";

import {
  createAuthoritativeM3Adapter,
} from "./authoritative-m3-adapter.js";

import {
  loadVerifiedProductionPackage,
} from "./verified-production-package.js";

import {
  getMediaResolutionManifestPath,
} from "./media-pipeline-registration.js";

import type {
  MediaCandidateProvider,
} from "./media-resolver.js";

import type {
  MediaStageOutput,
} from "./media-pipeline-stage.js";

export interface OfflineModeBAcceptanceOptions {
  context: PipelineContext;

  storageRoot: string;

  localImagePath: string;

  allowedLocalRoot: string;

  sourceId?: string;
}

export interface OfflineModeBAcceptanceResult {
  output: MediaStageOutput;

  reusedOutputValid: boolean;

  discoveryCalls: number;

  manifestPath: string;

  validateCheckpoint(): Promise<boolean>;
}

/**
 * Acceptance-only upstream stages.
 *
 * The actual script/storyboard results must already
 * exist in context.outputs and on disk.
 *
 * These stages cannot execute; the harness invokes
 * the real registered media stage directly.
 */
function upstreamStage(
  id: "script" | "storyboard",
): PipelineStage {
  return {
    id,
    version: "acceptance-existing-output-v1",

    dependencies:
      id === "storyboard"
        ? ["script"]
        : [],

    async execute() {
      throw new Error(
        `Acceptance harness must not execute ${id}`,
      );
    },
  };
}

export async function runOfflineModeBAcceptance(
  options: OfflineModeBAcceptanceOptions,
): Promise<OfflineModeBAcceptanceResult> {
  const { context } = options;

  const jobId = context.job.id;

  const sourceId =
    options.sourceId ??
    "m4-offline-acceptance-image";

  // 1. Independently verify the real saved M3
  // production package.
  const verified =
    await loadVerifiedProductionPackage({
      jobId,
      jobDirectory: context.jobDirectory,
      expectedMode: "B",
      adapter: createAuthoritativeM3Adapter(),
    });

  if (
    verified.mode !== "B" ||
    verified.shotIds.length === 0
  ) {
    throw new Error(
      "Offline acceptance requires a nonempty Mode B media plan",
    );
  }

  // 2. Use the actual storage services.
  const acquirer = new MediaAcquirer({
    storageRoot: options.storageRoot,

    allowedLocalRoots: [
      options.allowedLocalRoot,
    ],
  });

  const objectStore =
    new MediaObjectStore({
      storageRoot: options.storageRoot,
    });

  const rightsStore =
    new MediaUsageRightsStore(
      options.storageRoot,
    );

  const source = {
    provider: "local_library" as const,
    id: sourceId,
  };

  // 3. Pre-acquire the local file.
  // This creates an immutable verified object.
  const acquired = await acquirer.acquire({
    id: source.id,
    provider: source.provider,
    kind: "image",

    description:
      "Offline media-resolution acceptance fixture",

    localPath: options.localImagePath,
    keywords: [],
  });

  const asset = await objectStore.register(
    source,
    {
      ...acquired,

      provenance: {
        ...acquired.provenance,
        source: source.provider,
        providerAssetId: source.id,
      },
    },
  );

  // 4. Create an explicit test-only rights review.
  // Never use this automatic approval in production.
  await rightsStore.save({
    source,

    assetHash: asset.sha256,
    intendedUse: "commercial_youtube",

    reviewer: "offline-acceptance-fixture",
    reviewedAt: new Date().toISOString(),

    evidenceUrl:
      "https://example.com/offline-test-fixture",

    commercialPermission: "confirmed",
    personRelease: "not_required",
    propertyRelease: "not_required",
    attribution: "not_required",

    notes:
      "Synthetic acceptance approval for a test-owned image only",
  });

  // 5. Local-only candidate provider.
  // It returns the same verified fixture, with
  // the real M3 requirement's description.
  let discoveryCalls = 0;

  const provider: MediaCandidateProvider = {
    id: "offline-acceptance-local",

    supports: () => true,

    async search(requirement) {
      discoveryCalls += 1;

      return [{
        id: sourceId,

        provider: "local_library",
        kind: "image",

        description:
          requirement.description,

        localPath: options.localImagePath,

        width: asset.width,
        height: asset.height,

        keywords: [
          ...requirement.searchQueries,
        ],

        providerScore: 1,
      }];
    },
  };

  // 6. Register the REAL media stage in the
  // REAL M1 pipeline registry.
  const registry = new PipelineRegistry();

  registry.register(
    upstreamStage("script"),
  );

  registry.register(
    upstreamStage("storyboard"),
  );

  const mediaStage =
    createRegisteredModeBMediaStage({
      registry,

      storageRoot: options.storageRoot,

      jobDirectory(id) {
        if (id !== jobId) {
          throw new Error(
            "Acceptance job identity mismatch",
          );
        }

        return context.jobDirectory;
      },

      providers: () => [provider],

      allowedLocalRoots: () => [
        options.allowedLocalRoot,
      ],
    });

  const order = registry.resolveOrder()
    .map((stage) => stage.id);

  if (
    JSON.stringify(order) !==
    JSON.stringify([
      "script",
      "storyboard",
      "media",
    ])
  ) {
    throw new Error(
      "Unexpected media pipeline dependency order",
    );
  }

  // 7. Execute real media-resolution components.
  const output = await mediaStage.execute(
    context,
  );

  if (
    output.assignedCount !==
      verified.shotIds.length ||
    output.shotCount !==
      verified.shotIds.length
  ) {
    throw new Error(
      "Offline acceptance shot coverage mismatch",
    );
  }

  // 8. Revalidate the saved media checkpoint.
  // Must reverify objects and rights without
  // invoking candidate discovery again.
  const discoveryCountBeforeReuse =
    discoveryCalls;

  const reusedOutputValid =
    await mediaStage.validateOutput?.(
      output,
      context,
    ) ?? false;

  if (!reusedOutputValid) {
    throw new Error(
      "Offline acceptance media checkpoint reuse failed",
    );
  }

  if (
    discoveryCalls !==
    discoveryCountBeforeReuse
  ) {
    throw new Error(
      "Media checkpoint reuse triggered unnecessary discovery",
    );
  }

  return {
    output,
    reusedOutputValid,
    discoveryCalls,

    manifestPath:
      getMediaResolutionManifestPath(
        options.storageRoot,
        jobId,
      ),

    validateCheckpoint: () =>
      mediaStage.validateOutput?.(
        output,
        context,
      ) ?? Promise.resolve(false),
  };
}
