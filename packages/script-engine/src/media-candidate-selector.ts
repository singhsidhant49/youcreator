import { z } from "zod";

import {
  MediaCandidateSchema,
  type MediaCandidate,
  type MediaDiscoveryOutcome,
  type MediaRequirement,
} from "./media-resolver.js";

import {
  evaluateSemanticCandidate,
  type SemanticCandidateEvidence,
  type SemanticGateResult,
  type SemanticVisualRequirement,
} from "./media-semantic-gate.js";

const ScoreSchema = z.number().finite().min(0).max(1);

export const MediaSelectionPolicySchema = z.object({
  minimumScore: ScoreSchema.default(0.35),

  targetAspectRatio: z.number()
    .finite()
    .positive()
    .default(16 / 9),

  maximumAspectRatioDeviation: z.number()
    .finite()
    .min(0)
    .max(1)
    .default(0.4),

  relevanceWeight: ScoreSchema.default(0.65),
  aspectRatioWeight: ScoreSchema.default(0.2),
  sourcePreferenceWeight: ScoreSchema.default(0.15),

  repeatedAssetPenalty: ScoreSchema.default(0.35),
  adjacentAssetPenalty: ScoreSchema.default(0.45),
  disallowAdjacentDuplicates: z.boolean().default(false),
  negativeTermPenalty: ScoreSchema.default(0.60),
  styleMismatchPenalty: ScoreSchema.default(0.30),

  // Provider/source priority, not licensing approval.
  preferredSources: z.array(
    MediaCandidateSchema.shape.provider,
  ).default([
    "local_library",
    "pexels",
    "wikimedia",
    "other_stock",
    "shared_background",
    "manual_upload",
    "ai_generated",
  ]),
}).strict().superRefine((policy, ctx) => {
  const total =
    policy.relevanceWeight +
    policy.aspectRatioWeight +
    policy.sourcePreferenceWeight;

  if (Math.abs(total - 1) > 1e-9) {
    ctx.addIssue({
      code: "custom",
      message: "Selection weights must sum to 1",
    });
  }

  if (
    new Set(policy.preferredSources).size !==
    policy.preferredSources.length
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Preferred sources must be unique",
    });
  }
});

export type MediaSelectionPolicy = z.infer<
  typeof MediaSelectionPolicySchema
>;

export type MediaSelectionPolicyInput = z.input<
  typeof MediaSelectionPolicySchema
>;

export interface MediaSelectionContext {
  // The exact asset IDs used by previous shots.
  previouslySelectedAssetKeys?: readonly string[];

  // P0: Structured semantic visual requirement for this shot
  semanticRequirement?: SemanticVisualRequirement;

  // P0: Real candidate evidence keyed by asset ID or provider:id
  semanticEvidence?: Record<string, SemanticCandidateEvidence>;

  // Minimum score threshold for semantic evaluation (default: 80)
  semanticMinimumScore?: number;

  // Expected visual style (e.g. "photographic", "illustration", "vector", "diagram", "either")
  targetStyle?: "photographic" | "illustration" | "vector" | "diagram" | "either";
}

export interface MediaCandidateScore {
  candidate: MediaCandidate;

  relevanceScore: number;
  aspectRatioScore: number;
  sourcePreferenceScore: number;

  repeatedAsset: boolean;
  adjacentDuplicate?: boolean;
  negativeTermMatch?: boolean;
  styleMismatch?: boolean;
  semanticGateResult?: SemanticGateResult;
  finalScore: number;
}

export type MediaSelectionResult =
  | {
      status: "selected";
      shotId: string;
      candidate: MediaCandidate;
      score: MediaCandidateScore;
      ranked: MediaCandidateScore[];
    }
  | {
      status: "rejected";
      shotId: string;
      reason:
        | "NO_CANDIDATES"
        | "NO_COMPATIBLE_CANDIDATES"
        | "BELOW_MINIMUM_SCORE"
        | "SEMANTIC_GATE_REJECTED"
        | "ADJACENT_DUPLICATE_REJECTED";
      ranked: MediaCandidateScore[];
    };

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in",
  "on", "at", "to", "for", "with", "from",
  "by", "is", "are", "into", "inside",
  "show", "showing", "image", "photo",
  "photograph", "scene", "cinematic",
  "realistic", "close", "up",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) =>
        token.length > 1 &&
        !STOP_WORDS.has(token),
      ),
  );
}

function lexicalScore(
  requirement: MediaRequirement,
  candidate: MediaCandidate,
): number {
  const requested = tokenize([
    requirement.description,
    ...requirement.searchQueries,
  ].join(" "));

  if (requested.size === 0) {
    return 0;
  }

  const candidateTokens = tokenize([
    candidate.description,
    ...candidate.keywords,
  ].join(" "));

  let matched = 0;

  for (const term of requested) {
    if (candidateTokens.has(term)) {
      matched++;
    }
  }

  return matched / requested.size;
}

function relevanceScore(
  requirement: MediaRequirement,
  candidate: MediaCandidate,
): number {
  const lexical = lexicalScore(
    requirement,
    candidate,
  );

  if (candidate.providerScore === undefined) {
    return lexical;
  }

  // Provider scores are only weak supporting evidence.
  // They are not calibrated semantic similarity.
  return (
    lexical * 0.8 +
    candidate.providerScore * 0.2
  );
}

function aspectRatioScore(
  candidate: MediaCandidate,
  target: number,
  maximumDeviation: number,
): number {
  if (
    candidate.width === undefined ||
    candidate.height === undefined
  ) {
    // Unknown dimensions receive no aspect bonus.
    return 0;
  }

  const ratio = candidate.width / candidate.height;

  // Symmetric deviation around the target ratio.
  const deviation = Math.abs(
    Math.log(ratio / target),
  );

  if (
    maximumDeviation === 0
  ) {
    return deviation < 1e-9 ? 1 : 0;
  }

  return Math.max(
    0,
    1 - deviation / maximumDeviation,
  );
}

function sourcePreferenceScore(
  candidate: MediaCandidate,
  sources: readonly string[],
): number {
  const index = sources.indexOf(
    candidate.provider,
  );

  if (index === -1) {
    return 0;
  }

  if (sources.length === 1) {
    return 1;
  }

  return 1 - index / (sources.length - 1);
}

export function mediaCandidateKey(
  candidate: Pick<
    MediaCandidate,
    "provider" | "id"
  >,
): string {
  return `${candidate.provider}:${candidate.id}`;
}

function checkNegativeTerms(
  negativeTerms: readonly string[] | undefined,
  candidate: MediaCandidate,
): boolean {
  if (!negativeTerms || negativeTerms.length === 0) {
    return false;
  }
  const text = [
    candidate.description,
    ...candidate.keywords,
  ].join(" ").toLowerCase();

  return negativeTerms.some((neg) => {
    const term = neg.trim().toLowerCase();
    return term.length > 0 && text.includes(term);
  });
}

function checkStyleMismatch(
  targetStyle: string | undefined,
  candidate: MediaCandidate,
): boolean {
  if (!targetStyle || targetStyle === "either") {
    return false;
  }
  const tokens = tokenize([
    candidate.description,
    ...candidate.keywords,
  ].join(" "));

  if (targetStyle === "photographic") {
    const illustrationTokens = [
      "illustration",
      "vector",
      "cartoon",
      "drawing",
      "diagram",
      "clipart",
      "sketch",
    ];
    return illustrationTokens.some((t) => tokens.has(t));
  }

  if (targetStyle === "illustration" || targetStyle === "vector") {
    const photoTokens = [
      "photograph",
      "photo",
      "realistic photo",
      "headshot",
    ];
    return photoTokens.some((t) => tokens.has(t));
  }

  return false;
}

export class MediaCandidateSelector {
  readonly policy: MediaSelectionPolicy;

  constructor(
    policy: MediaSelectionPolicyInput = {},
  ) {
    this.policy = MediaSelectionPolicySchema.parse(
      policy,
    );
  }

  select(
    requirement: MediaRequirement,
    discovery: MediaDiscoveryOutcome,
    context: MediaSelectionContext = {},
  ): MediaSelectionResult {
    if (discovery.shotId !== requirement.shotId) {
      throw new Error(
        "Media discovery shot ID mismatch",
      );
    }

    if (discovery.candidates.length === 0) {
      return {
        status: "rejected",
        shotId: requirement.shotId,
        reason: "NO_CANDIDATES",
        ranked: [],
      };
    }

    const previousKeys = context.previouslySelectedAssetKeys ?? [];
    const previous = new Set(previousKeys);
    const lastKey = previousKeys.length > 0 ? previousKeys[previousKeys.length - 1] : undefined;

    const compatibleCandidates =
      discovery.candidates
        .map((candidate) =>
          MediaCandidateSchema.parse(candidate),
        )
        .filter((candidate) =>
          requirement.preferredMediaKind === "either" ||
          candidate.kind ===
            requirement.preferredMediaKind,
        );

    if (compatibleCandidates.length === 0) {
      return {
        status: "rejected",
        shotId: requirement.shotId,
        reason: "NO_COMPATIBLE_CANDIDATES",
        ranked: [],
      };
    }

    const ranked = compatibleCandidates
      .map((candidate): MediaCandidateScore => {
        const relevance = relevanceScore(
          requirement,
          candidate,
        );

        const aspect = aspectRatioScore(
          candidate,
          this.policy.targetAspectRatio,
          this.policy.maximumAspectRatioDeviation,
        );

        const source = sourcePreferenceScore(
          candidate,
          this.policy.preferredSources,
        );

        const candidateKey = mediaCandidateKey(candidate);
        const repeatedAsset = previous.has(candidateKey);
        const adjacentDuplicate = lastKey !== undefined && candidateKey === lastKey;

        // P0 Semantic Gate evaluation
        let semanticGateResult: SemanticGateResult | undefined;
        let rejectedBySemanticGate = false;

        if (context.semanticRequirement) {
          const evidence =
            context.semanticEvidence?.[candidate.id] ??
            context.semanticEvidence?.[candidateKey] ??
            (candidate as any).semanticEvidence;

          if (evidence) {
            semanticGateResult = evaluateSemanticCandidate(
              context.semanticRequirement,
              evidence,
              context.semanticMinimumScore ?? 80,
            );
            if (!semanticGateResult.accepted) {
              rejectedBySemanticGate = true;
            }
          } else {
            // Check metadata concepts against excluded concepts
            const text = [
              candidate.description,
              ...candidate.keywords,
            ].join(" ").toLowerCase();

            const forbidden = context.semanticRequirement.excludedConcepts.some(
              (concept) => text.includes(concept.toLowerCase()),
            );

            if (forbidden) {
              semanticGateResult = {
                accepted: false,
                reason: "EXCLUDED_CONCEPT_PRESENT",
              };
              rejectedBySemanticGate = true;
            }
          }
        }

        const negativeTermMatch = checkNegativeTerms(
          requirement.negativeTerms,
          candidate,
        );

        const styleMismatch = checkStyleMismatch(
          context.targetStyle,
          candidate,
        );

        const baseScore =
          relevance * this.policy.relevanceWeight +
          aspect * this.policy.aspectRatioWeight +
          source * this.policy.sourcePreferenceWeight;

        let finalScore = 0;

        if (!rejectedBySemanticGate) {
          let score = baseScore;

          if (adjacentDuplicate) {
            score -= this.policy.adjacentAssetPenalty;
          } else if (repeatedAsset) {
            score -= this.policy.repeatedAssetPenalty;
          }

          if (negativeTermMatch) {
            score -= this.policy.negativeTermPenalty;
          }

          if (styleMismatch) {
            score -= this.policy.styleMismatchPenalty;
          }

          finalScore = Math.max(0, Math.min(1, score));
        }

        return {
          candidate,
          relevanceScore: relevance,
          aspectRatioScore: aspect,
          sourcePreferenceScore: source,
          repeatedAsset,
          adjacentDuplicate,
          negativeTermMatch,
          styleMismatch,
          semanticGateResult,
          finalScore,
        };
      })
      .sort((a, b) => {
        // Gate-rejected candidates always rank last
        const aRejected = a.semanticGateResult && !a.semanticGateResult.accepted;
        const bRejected = b.semanticGateResult && !b.semanticGateResult.accepted;
        if (aRejected !== bRejected) {
          return aRejected ? 1 : -1;
        }

        return (
          b.finalScore - a.finalScore ||
          mediaCandidateKey(a.candidate).localeCompare(
            mediaCandidateKey(b.candidate),
          )
        );
      });

    // Check if all candidates failed the semantic gate
    if (
      context.semanticRequirement &&
      ranked.every((r) => r.semanticGateResult && !r.semanticGateResult.accepted)
    ) {
      return {
        status: "rejected",
        shotId: requirement.shotId,
        reason: "SEMANTIC_GATE_REJECTED",
        ranked,
      };
    }

    // Look for candidates that passed semantic gate and meet minimum score
    const acceptable = ranked.filter(
      (item) =>
        (!item.semanticGateResult || item.semanticGateResult.accepted) &&
        item.finalScore >= this.policy.minimumScore,
    );

    if (acceptable.length === 0) {
      // Check if top candidate was only rejected because it's an adjacent duplicate
      if (
        this.policy.disallowAdjacentDuplicates &&
        ranked[0]?.adjacentDuplicate
      ) {
        return {
          status: "rejected",
          shotId: requirement.shotId,
          reason: "ADJACENT_DUPLICATE_REJECTED",
          ranked,
        };
      }

      return {
        status: "rejected",
        shotId: requirement.shotId,
        reason: "BELOW_MINIMUM_SCORE",
        ranked,
      };
    }

    // Always prefer candidates that are NOT adjacent duplicates when available
    let chosen = acceptable[0]!;
    if (chosen.adjacentDuplicate) {
      const nonAdjacent = acceptable.find((item) => !item.adjacentDuplicate);
      if (nonAdjacent) {
        chosen = nonAdjacent;
      } else if (this.policy.disallowAdjacentDuplicates) {
        return {
          status: "rejected",
          shotId: requirement.shotId,
          reason: "ADJACENT_DUPLICATE_REJECTED",
          ranked,
        };
      }
    }

    return {
      status: "selected",
      shotId: requirement.shotId,
      candidate: chosen.candidate,
      score: chosen,
      ranked,
    };
  }
}
