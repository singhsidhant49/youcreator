export interface SemanticVisualRequirement {
  shotId: string;
  narration: string;
  primarySubject: string;
  domain: string;

  /**
   * Subjects that must be visually represented,
   * not merely mentioned in metadata.
   */
  requiredConcepts: string[];

  /**
   * Known incorrect subject/domain substitutions.
   */
  excludedConcepts: string[];
}

export interface SemanticCandidateEvidence {
  assetId: string;
  detectedConcepts: string[];
  excludedConceptsDetected: string[];
  relevanceScore: number;
  evidenceSource:
    | "vision_model"
    | "human_review"
    | "trusted_asset_metadata";
}

export type SemanticGateResult =
  | {
      accepted: true;
      score: number;
      assetId: string;
    }
  | {
      accepted: false;
      reason:
        | "LOW_RELEVANCE"
        | "REQUIRED_CONCEPT_MISSING"
        | "EXCLUDED_CONCEPT_PRESENT"
        | "UNVERIFIED_EVIDENCE";
    };

export function evaluateSemanticCandidate(
  requirement: SemanticVisualRequirement,
  candidate: SemanticCandidateEvidence,
  minimumScore = 80,
): SemanticGateResult {
  const normalized = new Set(
    candidate.detectedConcepts.map(
      (value) => value.trim().toLowerCase(),
    ),
  );

  const exclusions = new Set(
    candidate.excludedConceptsDetected.map(
      (value) => value.trim().toLowerCase(),
    ),
  );

  if (
    !candidate.evidenceSource ||
    !Number.isFinite(candidate.relevanceScore) ||
    candidate.relevanceScore < 0 ||
    candidate.relevanceScore > 100
  ) {
    return {
      accepted: false,
      reason: "UNVERIFIED_EVIDENCE",
    };
  }

  const forbidden = requirement.excludedConcepts.some(
    (concept) =>
      normalized.has(concept.toLowerCase()) ||
      exclusions.has(concept.toLowerCase()),
  );

  if (forbidden) {
    return {
      accepted: false,
      reason: "EXCLUDED_CONCEPT_PRESENT",
    };
  }

  const missing =
    requirement.requiredConcepts.some(
      (concept) =>
        !normalized.has(concept.toLowerCase()),
    );

  if (missing) {
    return {
      accepted: false,
      reason: "REQUIRED_CONCEPT_MISSING",
    };
  }

  if (candidate.relevanceScore < minimumScore) {
    return {
      accepted: false,
      reason: "LOW_RELEVANCE",
    };
  }

  return {
    accepted: true,
    score: candidate.relevanceScore,
    assetId: candidate.assetId,
  };
}
