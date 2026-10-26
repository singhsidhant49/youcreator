import { describe, expect, it } from "vitest";

import {
  evaluateSemanticCandidate,
  type SemanticCandidateEvidence,
  type SemanticVisualRequirement,
} from "./media-semantic-gate.js";

describe("M10.2 Semantic Visual-Selection Gate", () => {
  it("rejects Neptune narration paired with ocean photograph (EXCLUDED_CONCEPT_PRESENT)", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-4-2",
      narration: "Neptune's deep blue hides fierce winds.",
      primarySubject: "Neptune",
      domain: "planetary astronomy",
      requiredConcepts: ["neptune", "planet"],
      excludedConcepts: ["earth ocean", "sea waves", "ocean"],
    };

    const oceanCandidate: SemanticCandidateEvidence = {
      assetId: "pexels-ocean-001",
      detectedConcepts: ["earth ocean", "sea waves", "blue water"],
      excludedConceptsDetected: ["sea waves", "ocean"],
      relevanceScore: 25,
      evidenceSource: "vision_model",
    };

    const result = evaluateSemanticCandidate(requirement, oceanCandidate);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("EXCLUDED_CONCEPT_PRESENT");
    }
  });

  it("rejects AI word prediction paired with inflation dictionary entry (EXCLUDED_CONCEPT_PRESENT / REQUIRED_CONCEPT_MISSING)", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-3-2",
      narration: "predict the next word.",
      primarySubject: "autoregressive text prediction",
      domain: "machine learning language modeling",
      requiredConcepts: ["text prediction", "language modeling"],
      excludedConcepts: ["financial inflation", "economics dictionary", "inflation"],
    };

    const dictionaryCandidate: SemanticCandidateEvidence = {
      assetId: "pexels-dict-001",
      detectedConcepts: ["smartphone dictionary", "inflation", "economics definition"],
      excludedConceptsDetected: ["inflation", "economics definition"],
      relevanceScore: 20,
      evidenceSource: "trusted_asset_metadata",
    };

    const result = evaluateSemanticCandidate(requirement, dictionaryCandidate);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("EXCLUDED_CONCEPT_PRESENT");
    }
  });

  it("rejects Netflix video streaming paired with podcast studio mic (REQUIRED_CONCEPT_MISSING)", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-2-1",
      narration: "By 2007, Netflix pivoted to streaming, letting you watch instantly.",
      primarySubject: "video on demand streaming",
      domain: "entertainment streaming technology",
      requiredConcepts: ["video streaming", "screen interface"],
      excludedConcepts: ["podcast recording", "audio microphone studio"],
    };

    const podcastCandidate: SemanticCandidateEvidence = {
      assetId: "pexels-podcast-001",
      detectedConcepts: ["podcast recording", "studio microphone", "dark room laptop"],
      excludedConceptsDetected: ["podcast recording", "audio microphone studio"],
      relevanceScore: 40,
      evidenceSource: "vision_model",
    };

    const result = evaluateSemanticCandidate(requirement, podcastCandidate);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("EXCLUDED_CONCEPT_PRESENT");
    }
  });

  it("rejects asteroid belt narration paired with planetary lineup lacking asteroids (REQUIRED_CONCEPT_MISSING)", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-2-2",
      narration: "Beyond it lies the asteroid belt, a rocky boundary marking the inner solar system's edge.",
      primarySubject: "asteroid belt",
      domain: "planetary astronomy",
      requiredConcepts: ["asteroid belt", "rocky debris"],
      excludedConcepts: [],
    };

    const planetsOnlyCandidate: SemanticCandidateEvidence = {
      assetId: "pexels-planets-001",
      detectedConcepts: ["planets lineup", "sun and planets", "solar system overview"],
      excludedConceptsDetected: [],
      relevanceScore: 50,
      evidenceSource: "trusted_asset_metadata",
    };

    const result = evaluateSemanticCandidate(requirement, planetsOnlyCandidate);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("REQUIRED_CONCEPT_MISSING");
    }
  });

  it("accepts proper Neptune astronomy image when verified", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-4-2",
      narration: "Neptune's deep blue hides fierce winds.",
      primarySubject: "Neptune",
      domain: "planetary astronomy",
      requiredConcepts: ["neptune", "planet"],
      excludedConcepts: ["earth ocean", "sea waves"],
    };

    const validNeptuneCandidate: SemanticCandidateEvidence = {
      assetId: "astronomy-neptune-001",
      detectedConcepts: ["neptune", "planet", "deep blue atmosphere", "space"],
      excludedConceptsDetected: [],
      relevanceScore: 95,
      evidenceSource: "vision_model",
    };

    const result = evaluateSemanticCandidate(requirement, validNeptuneCandidate, 80);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.score).toBe(95);
      expect(result.assetId).toBe("astronomy-neptune-001");
    }
  });

  it("accepts appropriate semantic-vector illustration when verified", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-2-3",
      narration: "Those numbers encode meaning, so similar ideas land close together.",
      primarySubject: "vector embeddings clustering",
      domain: "machine learning natural language processing",
      requiredConcepts: ["vector space", "embeddings"],
      excludedConcepts: ["human crowd"],
    };

    const vectorSpaceCandidate: SemanticCandidateEvidence = {
      assetId: "asset-embeddings-3d",
      detectedConcepts: ["vector space", "embeddings", "semantic clusters", "data points"],
      excludedConceptsDetected: [],
      relevanceScore: 90,
      evidenceSource: "human_review",
    };

    const result = evaluateSemanticCandidate(requirement, vectorSpaceCandidate);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.score).toBe(90);
    }
  });

  it("rejects candidate when relevance score is below minimum threshold", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-1",
      narration: "Overview of neural networks.",
      primarySubject: "neural network",
      domain: "AI",
      requiredConcepts: ["neural network"],
      excludedConcepts: [],
    };

    const lowScoreCandidate: SemanticCandidateEvidence = {
      assetId: "asset-generic-lines",
      detectedConcepts: ["neural network", "abstract lines"],
      excludedConceptsDetected: [],
      relevanceScore: 72,
      evidenceSource: "vision_model",
    };

    const result = evaluateSemanticCandidate(requirement, lowScoreCandidate, 80);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("LOW_RELEVANCE");
    }
  });

  it("rejects unverified or invalid candidate evidence", () => {
    const requirement: SemanticVisualRequirement = {
      shotId: "shot-1",
      narration: "Testing unverified",
      primarySubject: "subject",
      domain: "domain",
      requiredConcepts: ["subject"],
      excludedConcepts: [],
    };

    const invalidScoreCandidate = {
      assetId: "asset-unverified",
      detectedConcepts: ["subject"],
      excludedConceptsDetected: [],
      relevanceScore: -5,
      evidenceSource: "vision_model" as const,
    };

    expect(evaluateSemanticCandidate(requirement, invalidScoreCandidate)).toEqual({
      accepted: false,
      reason: "UNVERIFIED_EVIDENCE",
    });
  });
});
