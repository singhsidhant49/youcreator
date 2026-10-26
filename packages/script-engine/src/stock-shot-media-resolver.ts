import {
  MediaAssetSchema,
  type MediaAsset,
} from "@youcreator/contracts";

import {
  MediaResolver,
  type MediaCandidate,
  type MediaDiscoveryOutcome,
  type MediaRequirement,
} from "./media-resolver.js";

import {
  MediaCandidateSelector,
  type MediaSelectionResult,
} from "./media-candidate-selector.js";

import { MediaAcquirer } from "./media-acquirer.js";
import { MediaObjectStore } from "./media-object-store.js";

import {
  AssignedMediaSchema,
  type MediaAssignmentOutcome,
} from "./assigned-media.js";

import type {
  ShotMediaResolver,
} from "./media-resolution-coordinator.js";

import type {
  SemanticVisualRequirement,
  SemanticCandidateEvidence,
} from "./media-semantic-gate.js";

import {
  DEFAULT_STOCK_VISUAL_POLICY,
  refineSearchQueries,
  type StockVisualPolicy,
} from "./stock-visual-policy.js";

export interface StockShotMediaResolverOptions {
  jobId: string;

  requirements: MediaRequirement[];

  discovery: MediaResolver;
  selector: MediaCandidateSelector;

  acquirer: MediaAcquirer;
  objectStore: MediaObjectStore;

  mode?: "A" | "B";

  previouslySelectedAssetKeys?: string[];
  semanticRequirements?: Record<string, SemanticVisualRequirement>;
  semanticEvidenceMap?: Record<string, SemanticCandidateEvidence>;
  targetStyle?: "photographic" | "illustration" | "vector" | "diagram" | "either";

  policy?: StockVisualPolicy;

  /**
   * Optional explicitly authorized fallback asset.
   * If provided and all candidates fail, used instead of a silent irrelevant match.
   */
  authorizedFallbackAsset?: MediaAsset;
}

function unresolved(
  shotId: string,
  message: string,
  reason: "INVALID_ASSET" | "MISSING_ASSET" | "MODE_MISMATCH" | "REVIEW_REQUIRED" = "INVALID_ASSET",
): MediaAssignmentOutcome {
  return {
    status: "unresolved",
    shotId,
    reason,
    message,
  };
}

/**
 * Mode A: Adaptive Stock & Web Visual Resolver.
 *
 * Implements the unified adaptive stock retrieval flow:
 * 1. Cheap local image bank retrieval and Pexels/stock search first.
 * 2. Candidate ranking via MediaCandidateSelector.
 * 3. Confidence evaluation: if weak match, escalates to refined queries and additional search.
 * 4. Semantic quality gate enforcement (domain anchors, negative concepts, license verification).
 * 5. Strict rejection with structured failure if no candidate passes.
 * 6. ZERO AI image-generation API calls.
 */
export class StockShotMediaResolver
  implements ShotMediaResolver
{
  private readonly requirements =
    new Map<string, MediaRequirement>();

  private readonly usedKeys: string[];
  private readonly policy: StockVisualPolicy;
  private readonly mode: "A" | "B";

  constructor(
    private readonly options: StockShotMediaResolverOptions,
  ) {
    if (!options.jobId.trim()) {
      throw new Error("jobId is required");
    }

    for (const requirement of options.requirements) {
      if (this.requirements.has(requirement.shotId)) {
        throw new Error(
          `Duplicate media requirement: ${requirement.shotId}`,
        );
      }

      this.requirements.set(
        requirement.shotId,
        requirement,
      );
    }

    this.usedKeys = [
      ...(options.previouslySelectedAssetKeys ?? []),
    ];
    this.policy = options.policy ?? DEFAULT_STOCK_VISUAL_POLICY;
    this.mode = options.mode ?? "B";
  }

  async resolve(
    shotId: string,
  ): Promise<MediaAssignmentOutcome> {
    const requirement = this.requirements.get(shotId);

    if (!requirement) {
      return unresolved(
        shotId,
        "No authoritative media requirement for shot",
      );
    }

    try {
      let accumulatedCandidates: MediaCandidate[] = [];
      const seenCandidateKeys = new Set<string>();

      const mergeCandidates = (newCandidates: MediaCandidate[]) => {
        for (const candidate of newCandidates) {
          const key = `${candidate.provider}:${candidate.id}`;
          if (!seenCandidateKeys.has(key)) {
            seenCandidateKeys.add(key);
            accumulatedCandidates.push(candidate);
          }
        }
      };

      let bestSelection: MediaSelectionResult | undefined;
      let attempt = 1;
      const maxAttempts = Math.max(1, this.policy.maxSearchAttempts);

      while (attempt <= maxAttempts) {
        // Derive queries for this attempt
        const queriesForAttempt = attempt === 1
          ? requirement.searchQueries
          : refineSearchQueries(
              requirement.searchQueries,
              requirement.description,
              requirement.negativeTerms,
              attempt,
            );

        const activeRequirement: MediaRequirement = {
          ...requirement,
          preferredMediaKind: requirement.preferredMediaKind === "video" ? "either" : requirement.preferredMediaKind,
          searchQueries: queriesForAttempt,
        };

        const discovery = await this.options.discovery.discover(
          activeRequirement,
          {
            jobId: this.options.jobId,
            mode: this.mode,
          },
        );

        if (discovery.status === "candidates_found") {
          mergeCandidates(discovery.candidates);
        }

        if (accumulatedCandidates.length > 0) {
          const syntheticDiscovery: MediaDiscoveryOutcome = {
            status: "candidates_found",
            shotId,
            candidates: accumulatedCandidates,
            attemptedProviders: discovery.attemptedProviders,
            providerErrors: discovery.providerErrors,
          };

          const selection = this.options.selector.select(
            activeRequirement,
            syntheticDiscovery,
            {
              previouslySelectedAssetKeys: this.usedKeys,
              semanticRequirement:
                this.options.semanticRequirements?.[shotId],
              semanticEvidence:
                this.options.semanticEvidenceMap,
              targetStyle:
                this.options.targetStyle,
              semanticMinimumScore:
                this.policy.minimumSemanticScore,
            },
          );

          bestSelection = selection;

          // Strong match criteria:
          // 1. Candidate was selected
          // 2. High confidence: either passes semantic gate with minimum score OR has strong finalScore
          if (selection.status === "selected") {
            const gate = selection.score.semanticGateResult;
            const gateScore = gate && gate.accepted ? gate.score : 0;
            const isStrongMatch =
              selection.score.finalScore >= 0.70 ||
              gateScore >= this.policy.minimumSemanticScore;

            if (isStrongMatch || attempt >= maxAttempts) {
              break;
            }
          }
        }

        attempt++;
      }

      if (!bestSelection || bestSelection.status !== "selected") {
        if (this.options.authorizedFallbackAsset) {
          return {
            status: "assigned",
            assignment: AssignedMediaSchema.parse({
              version: 1,
              shotId,
              mode: this.mode,
              assignmentSource: "local_library",
              asset: this.options.authorizedFallbackAsset,
              assignedAt: new Date().toISOString(),
            }),
          };
        }

        const rejectionReason = bestSelection?.reason ?? "NO_CANDIDATES_FOUND";
        return unresolved(
          shotId,
          `No acceptable media candidate: ${rejectionReason}`,
        );
      }

      const candidate = bestSelection.candidate;

      const source = {
        provider: candidate.provider,
        id: candidate.id,
      } as const;

      // Reuse existing verified content when possible.
      let asset =
        await this.options.objectStore.lookup(source);

      if (!asset) {
        const acquired =
          await this.options.acquirer.acquire(candidate);

        const normalized = MediaAssetSchema.parse({
          ...acquired,
          provenance: {
            ...acquired.provenance,
            source: candidate.provider,
            providerAssetId: candidate.id,
          },
        });

        asset =
          await this.options.objectStore.register(
            source,
            normalized,
          );
      }

      this.usedKeys.push(
        `${candidate.provider}:${candidate.id}`,
      );

      return {
        status: "assigned",
        assignment: AssignedMediaSchema.parse({
          version: 1,
          shotId,
          mode: this.mode,
          assignmentSource:
            candidate.provider === "local_library"
              ? "local_library"
              : "stock",
          asset,
          assignedAt: new Date().toISOString(),
        }),
      };
    } catch (error) {
      return unresolved(
        shotId,
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  }
}

/**
 * Canonical alias for New Mode A resolver.
 */
export const AdaptiveStockVisualResolver = StockShotMediaResolver;
