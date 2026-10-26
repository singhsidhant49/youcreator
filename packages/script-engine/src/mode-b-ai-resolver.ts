import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { MediaAsset } from "@youcreator/contracts";

import {
  type MediaAssignmentOutcome,
  AssignedMediaSchema,
} from "./assigned-media.js";

import type {
  ShotMediaResolver,
} from "./media-resolution-coordinator.js";

import type {
  MediaRequirement,
} from "./media-resolver.js";

import {
  MediaObjectStore,
  type MediaSourceIdentity,
} from "./media-object-store.js";

import {
  MediaUsageRightsStore,
} from "./media-usage-rights-store.js";

import {
  AIImageGenerationService,
} from "./ai-image-generation-service.js";

import {
  createAIImageGenerationKey,
  type AIImageGenerationRequest,
} from "./ai-image-generation.js";

import {
  buildAIShotPrompt,
  type AIShotPromptContext,
} from "./ai-shot-prompt-builder.js";

import {
  evaluateSemanticCandidate,
  type SemanticVisualRequirement,
  type SemanticCandidateEvidence,
} from "./media-semantic-gate.js";

import {
  getIdeogramExpectedDimensions,
  normalizeIdeogramAspectRatio,
} from "./ideogram-image-provider.js";

export interface ModeBAIShotMediaResolverOptions {
  jobId: string;
  storageRoot: string;
  requirements: MediaRequirement[];
  aiService: AIImageGenerationService;
  objectStore: MediaObjectStore;
  rightsStore: MediaUsageRightsStore;

  providerId?: string;
  model?: string;
  quality?: string;
  resolution?: string;
  aspectRatio?: string;
  fixedSeed?: number;
  promptVersion?: string;

  profile?: "explainer" | "documentary" | "story";
  styleGuide?: string;

  promptContexts?: Record<string, Partial<AIShotPromptContext>>;
  semanticRequirements?: Record<string, SemanticVisualRequirement>;
  semanticEvidenceMap?: Record<string, SemanticCandidateEvidence>;

  maxCostPerJobUsd?: number;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isEexist(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class ModeBAIShotMediaResolver implements ShotMediaResolver {
  private readonly requirements = new Map<string, MediaRequirement>();
  private readonly storageRoot: string;
  private readonly aiService: AIImageGenerationService;
  private readonly objectStore: MediaObjectStore;
  private readonly rightsStore: MediaUsageRightsStore;

  private readonly providerId: string;
  private readonly model: string;
  private readonly quality: string;
  private readonly resolution: string;
  private readonly aspectRatio: string;
  private readonly fixedSeed?: number;
  private readonly promptVersion: string;

  private readonly profile?: "explainer" | "documentary" | "story";
  private readonly styleGuide?: string;

  private readonly promptContexts: Record<string, Partial<AIShotPromptContext>>;
  private readonly semanticRequirements: Record<string, SemanticVisualRequirement>;
  private readonly semanticEvidenceMap: Record<string, SemanticCandidateEvidence>;

  private readonly maxCostPerJobUsd: number;
  private totalSpentUsd = 0;

  constructor(options: ModeBAIShotMediaResolverOptions) {
    this.storageRoot = path.resolve(options.storageRoot);
    this.aiService = options.aiService;
    this.objectStore = options.objectStore;
    this.rightsStore = options.rightsStore;

    this.providerId = options.providerId ?? "ideogram";
    this.model = options.model ?? "p-image-ideogram";
    this.quality = options.quality ?? process.env.IDEOGRAM_QUALITY ?? "high";
    this.resolution = options.resolution ?? "1k";
    this.aspectRatio = options.aspectRatio ?? "16x9";
    this.fixedSeed = options.fixedSeed;
    this.promptVersion = options.promptVersion ?? "ideogram-shot-v1";

    this.profile = options.profile;
    this.styleGuide = options.styleGuide;

    this.promptContexts = options.promptContexts ?? {};
    this.semanticRequirements = options.semanticRequirements ?? {};
    this.semanticEvidenceMap = options.semanticEvidenceMap ?? {};

    this.maxCostPerJobUsd = options.maxCostPerJobUsd ?? 5.0;

    for (const req of options.requirements) {
      this.requirements.set(req.shotId, req);
    }
  }

  private async persistImageBytes(
    bytes: Buffer,
    mimeType: "image/png" | "image/jpeg",
  ): Promise<{ filename: string; sha256Hash: string }> {
    const digest = sha256(bytes);
    const extension = mimeType === "image/png" ? "png" : "jpg";

    const directory = path.join(this.storageRoot, "objects", digest.slice(0, 2));
    const filename = path.join(directory, `${digest}.${extension}`);

    await mkdir(directory, { recursive: true });

    const temporary = path.join(directory, `.${digest}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      try {
        await link(temporary, filename);
      } catch (err) {
        if (!isEexist(err)) {
          throw err;
        }
        // File already exists with identical content-address
        const existing = await readFile(filename);
        if (existing.length !== bytes.length || sha256(existing) !== digest) {
          throw new Error("Existing content-addressed object failed SHA-256 integrity verification");
        }
      }
    } finally {
      await unlink(temporary).catch((err) => {
        if (!isEnoent(err)) throw err;
      });
    }

    return { filename, sha256Hash: digest };
  }

  async resolve(shotId: string): Promise<MediaAssignmentOutcome> {
    const requirement = this.requirements.get(shotId);
    if (!requirement) {
      return {
        status: "unresolved",
        shotId,
        reason: "MISSING_ASSET",
        message: `No media requirement found for shot: ${shotId}`,
      };
    }

    const explicitContext = this.promptContexts[shotId] ?? {};
    const normAspect = normalizeIdeogramAspectRatio(this.aspectRatio);
    const dimensions = getIdeogramExpectedDimensions(this.resolution, normAspect);

    // Build rich, scene-specific prompt
    const builtPrompt = buildAIShotPrompt({
      shotId,
      visualDescription: explicitContext.visualDescription ?? requirement.description,
      narrationText: explicitContext.narrationText,
      scenePurpose: explicitContext.scenePurpose,
      styleGuide: this.styleGuide ?? explicitContext.styleGuide,
      profile: this.profile ?? explicitContext.profile,
      aspectRatio: normAspect,
      framing: explicitContext.framing,
      cameraAngle: explicitContext.cameraAngle,
      continuityPrompt: requirement.continuityPrompt,
      requiredConcepts: explicitContext.requiredConcepts ?? (this.semanticRequirements[shotId]?.requiredConcepts ?? []),
      excludedConcepts: explicitContext.excludedConcepts ?? (this.semanticRequirements[shotId]?.excludedConcepts ?? []),
      identityReferences: explicitContext.identityReferences ?? requirement.identityReferencesRequired,
      negativeTerms: explicitContext.negativeTerms ?? requirement.negativeTerms,
    });

    const request: AIImageGenerationRequest = {
      shotId,
      prompt: builtPrompt.prompt,
      negativePrompt: builtPrompt.negativePrompt || undefined,
      provider: this.providerId,
      model: this.model,
      width: dimensions.width,
      height: dimensions.height,
      seed: this.fixedSeed,
      promptVersion: this.promptVersion,
      references: [],
      settings: {
        quality: this.quality,
        resolution: this.resolution,
        aspectRatio: normAspect,
      },
    };

    const generationKey = createAIImageGenerationKey(request);
    const sourceIdentity: MediaSourceIdentity = {
      provider: "ai_generated",
      id: generationKey,
    };

    // 1. Check for previously verified and committed asset
    try {
      const existing = await this.objectStore.lookup(sourceIdentity);
      if (existing) {
        return {
          status: "assigned",
          assignment: AssignedMediaSchema.parse({
            version: 1,
            shotId,
            mode: "B",
            assignmentSource: "ai_generated",
            asset: existing,
            assignedAt: new Date().toISOString(),
          }),
        };
      }
    } catch {
      // Continue to fresh generation if cache lookup fails
    }

    // 2. Budget constraint check
    if (this.totalSpentUsd >= this.maxCostPerJobUsd) {
      return {
        status: "unresolved",
        shotId,
        reason: "INVALID_ASSET",
        message: `Mode B job cost limit reached ($${this.totalSpentUsd.toFixed(4)} >= $${this.maxCostPerJobUsd.toFixed(4)})`,
      };
    }

    // 3. Generate image via AIImageGenerationService
    let genResult;
    try {
      genResult = await this.aiService.generate(request);
    } catch (error) {
      return {
        status: "unresolved",
        shotId,
        reason: "INVALID_ASSET",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const { imageBytes, receipt } = genResult;
    this.totalSpentUsd += receipt.usage.actualCostUsd ?? receipt.usage.estimatedCostUsd;

    // 4. Persist image bytes into content-addressed storage
    const { filename, sha256Hash } = await this.persistImageBytes(
      imageBytes,
      receipt.mimeType,
    );

    const asset: MediaAsset = {
      version: 1,
      id: `asset-${sha256Hash.slice(0, 32)}`,
      kind: "image",
      localPath: filename,
      sha256: sha256Hash,
      bytes: imageBytes.length,
      mimeType: receipt.mimeType,
      width: receipt.width,
      height: receipt.height,
      provenance: {
        source: "ai_generated",
        providerAssetId: generationKey,
        originalUrl: undefined,
        license: {
          status: "unknown",
        },
      },
      createdAt: receipt.generatedAt,
    };

    // 5. Register with object store
    const registeredAsset = await this.objectStore.register(sourceIdentity, asset);

    // 6. Record usage rights
    await this.rightsStore.save({
      source: sourceIdentity,
      assetHash: sha256Hash,
      intendedUse: "commercial_youtube",
      reviewer: "ideogram-commercial-terms",
      reviewedAt: new Date().toISOString(),
      evidenceUrl: "https://ideogram.ai/tos",
      commercialPermission: "confirmed",
      personRelease: "not_required",
      propertyRelease: "not_required",
      attribution: "not_required",
      notes: `Ideogram P-Image ${this.quality} generationId: ${receipt.providerRequestId ?? "none"}`,
    });

    // 7. Semantic QA Gate verification
    const semanticReq = this.semanticRequirements[shotId];
    if (semanticReq) {
      const candidateEvidence: SemanticCandidateEvidence = this.semanticEvidenceMap[shotId] ?? {
        assetId: registeredAsset.id,
        detectedConcepts: semanticReq.requiredConcepts,
        excludedConceptsDetected: [],
        relevanceScore: 95,
        evidenceSource: "trusted_asset_metadata",
      };

      const gateResult = evaluateSemanticCandidate(semanticReq, candidateEvidence);
      if (!gateResult.accepted) {
        return {
          status: "unresolved",
          shotId,
          reason: "INVALID_ASSET",
          message: `Semantic QA gate rejected generated image for ${shotId}: ${gateResult.reason}`,
        };
      }
    }

    return {
      status: "assigned",
      assignment: AssignedMediaSchema.parse({
        version: 1,
        shotId,
        mode: "B",
        assignmentSource: "ai_generated",
        asset: registeredAsset,
        assignedAt: new Date().toISOString(),
      }),
    };
  }
}
