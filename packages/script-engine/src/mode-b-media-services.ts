import {
  MediaResolver,
  type MediaCandidateProvider,
  type MediaRequirement,
} from "./media-resolver.js";

import {
  MediaCandidateSelector,
} from "./media-candidate-selector.js";

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
  ManualSharedMediaService,
} from "./manual-shared-media.js";

import {
  MediaResolutionCoordinator,
} from "./media-resolution-coordinator.js";

import {
  PersistentMediaResolutionStage,
} from "./persistent-media-resolution.js";

import {
  StoredMediaAssetVerifier,
  StoredMediaRightsChecker,
} from "./media-production-adapters.js";

import {
  StockShotMediaResolver,
} from "./stock-shot-media-resolver.js";

import type {
  AIImageProvider,
} from "./ai-image-generation.js";

import {
  AIImageGenerationService,
  type AIImageGenerationServiceOptions,
} from "./ai-image-generation-service.js";

import {
  ModeBAIShotMediaResolver,
} from "./mode-b-ai-resolver.js";

import {
  IdeogramImageProvider,
} from "./ideogram-image-provider.js";

import type {
  AIShotPromptContext,
} from "./ai-shot-prompt-builder.js";

import type {
  ShotMediaResolver,
} from "./media-resolution-coordinator.js";

export interface ModeBMediaServicesOptions {
  jobId: string;

  /**
   * These must come from the verified M3
   * production package.
   */
  requirements: MediaRequirement[];

  storageRoot: string;

  /**
   * Only trusted local upload/bank roots.
   */
  allowedLocalRoots: string[];

  /**
   * Discovery providers for stock search (Mode A or historical Mode B).
   */
  providers?: MediaCandidateProvider[];

  /**
   * Optional custom AI resolver or AI provider for Canonical Mode B.
   */
  aiResolver?: ShotMediaResolver;
  aiProvider?: AIImageProvider;
  aiServiceOptions?: AIImageGenerationServiceOptions;

  promptContexts?: Record<string, Partial<AIShotPromptContext>>;
  profile?: "explainer" | "documentary" | "story";
  styleGuide?: string;

  semanticRequirements?: Record<string, import("./media-semantic-gate.js").SemanticVisualRequirement>;
  semanticEvidenceMap?: Record<string, import("./media-semantic-gate.js").SemanticCandidateEvidence>;
  targetStyle?: "photographic" | "illustration" | "vector" | "diagram" | "either";
  targetAspectRatio?: number;
}

export interface ModeBMediaServices {
  coordinator: MediaResolutionCoordinator;

  persistentStage: PersistentMediaResolutionStage;

  objectStore: MediaObjectStore;
  rightsStore: MediaUsageRightsStore;

  verifier: StoredMediaAssetVerifier;
  rightsChecker: StoredMediaRightsChecker;

  stockResolver?: StockShotMediaResolver;
  aiResolver?: ShotMediaResolver;
}

export function createModeBMediaServices(
  options: ModeBMediaServicesOptions,
): ModeBMediaServices {
  if (!options.jobId.trim()) {
    throw new Error("jobId is required");
  }

  if (!options.storageRoot.trim()) {
    throw new Error("storageRoot is required");
  }

  const providers = options.providers ?? [];

  if (providers.length === 0 && !options.aiResolver && !options.aiProvider && !process.env.IDEOGRAM_API_KEY) {
    throw new Error(
      "Mode B requires at least one media discovery provider or AI image provider",
    );
  }

  const expectedIds = new Set<string>();

  for (const requirement of options.requirements) {
    if (expectedIds.has(requirement.shotId)) {
      throw new Error(
        `Duplicate M3 requirement: ${requirement.shotId}`,
      );
    }

    expectedIds.add(requirement.shotId);
  }

  const acquirer = new MediaAcquirer({
    storageRoot: options.storageRoot,
    allowedLocalRoots: options.allowedLocalRoots,
  });

  const objectStore = new MediaObjectStore({
    storageRoot: options.storageRoot,
  });

  const rightsStore = new MediaUsageRightsStore(
    options.storageRoot,
  );

  const verifier = new StoredMediaAssetVerifier(
    objectStore,
  );

  const rightsChecker = new StoredMediaRightsChecker({
    objectStore,
    rightsStore,
  });

  let stockResolver: StockShotMediaResolver | undefined;
  if (providers.length > 0) {
    const discovery = new MediaResolver(providers);
    const selectorPolicy = options.targetAspectRatio !== undefined
      ? { targetAspectRatio: options.targetAspectRatio }
      : undefined;
    stockResolver = new StockShotMediaResolver({
      jobId: options.jobId,
      requirements: options.requirements,
      discovery,
      selector: new MediaCandidateSelector(selectorPolicy),
      acquirer,
      objectStore,
      semanticRequirements: options.semanticRequirements,
      semanticEvidenceMap: options.semanticEvidenceMap,
      targetStyle: options.targetStyle,
    });
  }

  let aiResolver = options.aiResolver;
  if (!aiResolver && (options.aiProvider || process.env.IDEOGRAM_API_KEY)) {
    const aiProvider = options.aiProvider ?? new IdeogramImageProvider({
      apiKey: process.env.IDEOGRAM_API_KEY,
    });
    const aiService = new AIImageGenerationService([aiProvider], options.aiServiceOptions);
    aiResolver = new ModeBAIShotMediaResolver({
      jobId: options.jobId,
      storageRoot: options.storageRoot,
      requirements: options.requirements,
      aiService,
      objectStore,
      rightsStore,
      profile: options.profile,
      styleGuide: options.styleGuide,
      promptContexts: options.promptContexts,
      semanticRequirements: options.semanticRequirements,
      semanticEvidenceMap: options.semanticEvidenceMap,
    });
  }

  const manualShared = new ManualSharedMediaService({
    acquirer,
    objectStore,
  });

  const coordinator = new MediaResolutionCoordinator({
    manualShared,
    stockResolver,
    aiResolver,
    assetVerifier: verifier,
    rightsChecker,
  });

  const persistentStage =
    new PersistentMediaResolutionStage({
      storageRoot: options.storageRoot,
      coordinator,
      assetVerifier: verifier,
      rightsChecker,
      allowNonBillableRecovery: true,
    });

  return {
    coordinator,
    persistentStage,
    objectStore,
    rightsStore,
    verifier,
    rightsChecker,
    stockResolver,
    aiResolver,
  };
}
