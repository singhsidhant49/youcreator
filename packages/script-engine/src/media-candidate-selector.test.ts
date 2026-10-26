import {
  describe,
  expect,
  it,
} from "vitest";

import {
  MediaCandidateSelector,
  mediaCandidateKey,
} from "./media-candidate-selector.js";

import type {
  MediaCandidate,
  MediaDiscoveryOutcome,
  MediaRequirement,
} from "./media-resolver.js";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
} from "./scene-media-plan.js";

import {
  storyboard,
} from "./visual-continuity.test-fixture.js";

const continuity = planVisualContinuity(
  storyboard,
  "documentary",
);

const mediaPlan = createSceneMediaPlan(
  storyboard,
  continuity,
  "B",
);

const requirement: MediaRequirement = {
  ...mediaPlan.shots[0]!,
  description: "Person working at a desk with laptop",
  searchQueries: [
    "person working desk laptop",
  ],
  preferredMediaKind: "image",
};

function candidate(
  id: string,
  overrides: Partial<MediaCandidate> = {},
): MediaCandidate {
  return {
    id,
    provider: "local_library",
    kind: "image",
    description:
      "Person working at a desk with laptop",
    width: 1920,
    height: 1080,
    keywords: [
      "person",
      "desk",
      "working",
      "laptop",
    ],
    ...overrides,
  };
}

function discovery(
  candidates: MediaCandidate[],
): MediaDiscoveryOutcome {
  if (candidates.length === 0) {
    return {
      status: "no_candidates",
      shotId: requirement.shotId,
      candidates: [],
      attemptedProviders: [
        "local-image-bank",
      ],
      providerErrors: [],
    };
  }

  return {
    status: "candidates_found",
    shotId: requirement.shotId,
    candidates,
    attemptedProviders: [
      "local-image-bank",
    ],
    providerErrors: [],
  };
}

describe("MediaCandidateSelector", () => {
  it("selects a highly relevant image", () => {
    const selector = new MediaCandidateSelector();

    const result = selector.select(
      requirement,
      discovery([
        candidate("desk-001"),
      ]),
    );

    expect(result.status).toBe("selected");

    if (result.status === "selected") {
      expect(result.candidate.id).toBe(
        "desk-001",
      );

      expect(result.score.finalScore)
        .toBeGreaterThanOrEqual(0.35);
    }
  });

  it("ranks relevant images above unrelated images", () => {
    const selector = new MediaCandidateSelector();

    const result = selector.select(
      requirement,
      discovery([
        candidate("server-001", {
          description:
            "Rows of servers in a data center",
          keywords: [
            "cloud",
            "infrastructure",
          ],
        }),
        candidate("desk-001"),
      ]),
    );

    expect(result.status).toBe("selected");

    if (result.status === "selected") {
      expect(result.candidate.id).toBe(
        "desk-001",
      );
    }
  });

  it("rejects when no candidates exist", () => {
    const selector = new MediaCandidateSelector();

    const result = selector.select(
      requirement,
      discovery([]),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "NO_CANDIDATES",
    });
  });

  it("rejects candidates below minimum score", () => {
    const selector = new MediaCandidateSelector({
      minimumScore: 0.9,
    });

    const result = selector.select(
      requirement,
      discovery([
        candidate("irrelevant", {
          description:
            "Mountain landscape during sunset",
          keywords: ["mountain", "sunset"],
          width: 800,
          height: 1200,
        }),
      ]),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "BELOW_MINIMUM_SCORE",
    });
  });

  it("prefers matching aspect ratios", () => {
    const selector = new MediaCandidateSelector();

    const result = selector.select(
      requirement,
      discovery([
        candidate("portrait", {
          width: 1080,
          height: 1920,
        }),
        candidate("landscape", {
          width: 1920,
          height: 1080,
        }),
      ]),
    );

    expect(result.status).toBe("selected");

    if (result.status === "selected") {
      expect(result.candidate.id).toBe(
        "landscape",
      );
    }
  });

  it("penalizes repeated assets", () => {
    const selector = new MediaCandidateSelector();

    const repeated = candidate("desk-001");
    const alternative = candidate("desk-002");

    const result = selector.select(
      requirement,
      discovery([
        repeated,
        alternative,
      ]),
      {
        previouslySelectedAssetKeys: [
          mediaCandidateKey(repeated),
        ],
      },
    );

    expect(result.status).toBe("selected");

    if (result.status === "selected") {
      expect(result.candidate.id).toBe(
        "desk-002",
      );
    }
  });

  it("prioritizes local library when scores are equal otherwise", () => {
    const selector = new MediaCandidateSelector();

    const result = selector.select(
      requirement,
      discovery([
        candidate("stock-001", {
          provider: "pexels",
        }),
        candidate("local-001", {
          provider: "local_library",
        }),
      ]),
    );

    expect(result.status).toBe("selected");

    if (result.status === "selected") {
      expect(result.candidate.id).toBe(
        "local-001",
      );
    }
  });

  it("rejects incompatible media kinds", () => {
    const selector = new MediaCandidateSelector();

    const result = selector.select(
      requirement,
      discovery([
        candidate("video-001", {
          kind: "video",
          durationSeconds: 10,
        }),
      ]),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "NO_COMPATIBLE_CANDIDATES",
    });
  });

  it("rejects invalid policy weights", () => {
    expect(() =>
      new MediaCandidateSelector({
        relevanceWeight: 0.8,
        aspectRatioWeight: 0.3,
        sourcePreferenceWeight: 0.2,
      }),
    ).toThrow();
  });

  describe("M10.2 regression & creative quality gates", () => {
    it("rejects Neptune ocean candidate via semantic gate even if title mentions Neptune", () => {
      const selector = new MediaCandidateSelector();

      const oceanCandidate = candidate("neptune-ocean-001", {
        description: "Neptune fierce winds over ocean waves",
        keywords: ["neptune", "winds", "ocean", "waves"],
      });

      const result = selector.select(
        requirement,
        discovery([oceanCandidate]),
        {
          semanticRequirement: {
            shotId: requirement.shotId,
            narration: "Neptune's deep blue hides fierce winds.",
            primarySubject: "Neptune",
            domain: "planetary astronomy",
            requiredConcepts: ["neptune", "planet"],
            excludedConcepts: ["earth ocean", "sea waves", "ocean"],
          },
          semanticEvidence: {
            "neptune-ocean-001": {
              assetId: "neptune-ocean-001",
              detectedConcepts: ["earth ocean", "sea waves"],
              excludedConceptsDetected: ["sea waves", "earth ocean"],
              relevanceScore: 25,
              evidenceSource: "vision_model",
            },
          },
        },
      );

      expect(result).toMatchObject({
        status: "rejected",
        reason: "SEMANTIC_GATE_REJECTED",
      });
    });

    it("accepts verified Neptune astronomy photograph", () => {
      const selector = new MediaCandidateSelector();

      const planetCandidate = candidate("neptune-planet-001", {
        description: "Voyager 2 high resolution view of planet Neptune",
        keywords: ["neptune", "planet", "astronomy", "atmosphere"],
      });

      const result = selector.select(
        requirement,
        discovery([planetCandidate]),
        {
          semanticRequirement: {
            shotId: requirement.shotId,
            narration: "Neptune's deep blue hides fierce winds.",
            primarySubject: "Neptune",
            domain: "planetary astronomy",
            requiredConcepts: ["neptune", "planet"],
            excludedConcepts: ["earth ocean", "sea waves", "ocean"],
          },
          semanticEvidence: {
            "neptune-planet-001": {
              assetId: "neptune-planet-001",
              detectedConcepts: ["neptune", "planet", "atmosphere"],
              excludedConceptsDetected: [],
              relevanceScore: 94,
              evidenceSource: "vision_model",
            },
          },
        },
      );

      expect(result.status).toBe("selected");
      if (result.status === "selected") {
        expect(result.candidate.id).toBe("neptune-planet-001");
      }
    });

    it("rejects inflation dictionary for AI word prediction narration", () => {
      const selector = new MediaCandidateSelector();

      const dictionaryCandidate = candidate("dict-inflation-001", {
        description: "Close up dictionary definition of inflation word",
        keywords: ["dictionary", "inflation", "text", "word"],
      });

      const result = selector.select(
        requirement,
        discovery([dictionaryCandidate]),
        {
          semanticRequirement: {
            shotId: requirement.shotId,
            narration: "AI predicts the next word in a sequence.",
            primarySubject: "AI word prediction",
            domain: "machine learning",
            requiredConcepts: ["ai", "word prediction"],
            excludedConcepts: ["inflation", "dictionary entry", "finance"],
          },
          semanticEvidence: {
            "dict-inflation-001": {
              assetId: "dict-inflation-001",
              detectedConcepts: ["dictionary entry", "inflation", "book"],
              excludedConceptsDetected: ["inflation", "dictionary entry"],
              relevanceScore: 20,
              evidenceSource: "vision_model",
            },
          },
        },
      );

      expect(result).toMatchObject({
        status: "rejected",
        reason: "SEMANTIC_GATE_REJECTED",
      });
    });

    it("rejects podcast microphone for Netflix video streaming narration", () => {
      const selector = new MediaCandidateSelector();

      const podcastCandidate = candidate("podcast-mic-001", {
        description: "Studio microphone in podcast recording booth",
        keywords: ["podcast", "microphone", "studio", "audio"],
      });

      const result = selector.select(
        requirement,
        discovery([podcastCandidate]),
        {
          semanticRequirement: {
            shotId: requirement.shotId,
            narration: "Netflix revolutionized how we stream video at home.",
            primarySubject: "streaming video",
            domain: "entertainment technology",
            requiredConcepts: ["streaming", "video"],
            excludedConcepts: ["podcast microphone", "recording studio"],
          },
          semanticEvidence: {
            "podcast-mic-001": {
              assetId: "podcast-mic-001",
              detectedConcepts: ["podcast microphone", "recording studio"],
              excludedConceptsDetected: ["podcast microphone", "recording studio"],
              relevanceScore: 30,
              evidenceSource: "vision_model",
            },
          },
        },
      );

      expect(result).toMatchObject({
        status: "rejected",
        reason: "SEMANTIC_GATE_REJECTED",
      });
    });

    it("rejects planetary lineup candidate missing required asteroid belt", () => {
      const selector = new MediaCandidateSelector();

      const lineupCandidate = candidate("solar-lineup-001", {
        description: "Artistic alignment of the eight solar system planets",
        keywords: ["planets", "solar system", "alignment"],
      });

      const result = selector.select(
        requirement,
        discovery([lineupCandidate]),
        {
          semanticRequirement: {
            shotId: requirement.shotId,
            narration: "Between Mars and Jupiter lies the asteroid belt.",
            primarySubject: "asteroid belt",
            domain: "solar system astronomy",
            requiredConcepts: ["asteroid belt", "asteroids"],
            excludedConcepts: ["smooth planetary lineup without asteroids"],
          },
          semanticEvidence: {
            "solar-lineup-001": {
              assetId: "solar-lineup-001",
              detectedConcepts: ["planets", "solar system"],
              excludedConceptsDetected: [],
              relevanceScore: 50,
              evidenceSource: "vision_model",
            },
          },
        },
      );

      expect(result).toMatchObject({
        status: "rejected",
        reason: "SEMANTIC_GATE_REJECTED",
      });
    });

    it("accepts appropriate semantic-vector illustration when verified", () => {
      const selector = new MediaCandidateSelector();

      const vectorCandidate = candidate("neural-vector-001", {
        description: "Vector diagram of neural language model next word probability",
        keywords: ["ai", "word prediction", "algorithm", "vector"],
      });

      const result = selector.select(
        requirement,
        discovery([vectorCandidate]),
        {
          semanticRequirement: {
            shotId: requirement.shotId,
            narration: "AI predicts the next word in a sequence.",
            primarySubject: "AI word prediction",
            domain: "machine learning",
            requiredConcepts: ["ai", "word prediction"],
            excludedConcepts: ["inflation", "dictionary entry", "finance"],
          },
          semanticEvidence: {
            "neural-vector-001": {
              assetId: "neural-vector-001",
              detectedConcepts: ["ai", "word prediction", "algorithm"],
              excludedConceptsDetected: [],
              relevanceScore: 88,
              evidenceSource: "trusted_asset_metadata",
            },
          },
        },
      );

      expect(result.status).toBe("selected");
      if (result.status === "selected") {
        expect(result.candidate.id).toBe("neural-vector-001");
      }
    });

    it("selects alternative candidate to prevent consecutive adjacent duplicate visuals", () => {
      const selector = new MediaCandidateSelector();

      const repeatedCandidate = candidate("planet-lineup-001", {
        description: "Person working at a desk with laptop",
      });
      const alternativeCandidate = candidate("asteroid-field-002", {
        description: "Person working at a desk with laptop",
      });

      const result = selector.select(
        requirement,
        discovery([repeatedCandidate, alternativeCandidate]),
        {
          previouslySelectedAssetKeys: [
            mediaCandidateKey(repeatedCandidate),
          ],
        },
      );

      expect(result.status).toBe("selected");
      if (result.status === "selected") {
        expect(result.candidate.id).toBe("asteroid-field-002");
      }
    });

    it("penalizes and avoids candidates matching negative terms", () => {
      const selector = new MediaCandidateSelector();

      const cartoonCandidate = candidate("cartoon-desk-001", {
        description: "Cartoon 2D drawing of person working at desk",
        keywords: ["cartoon", "drawing", "person", "desk"],
      });
      const realisticCandidate = candidate("photo-desk-002", {
        description: "Realistic photo of person working at desk",
        keywords: ["photo", "person", "desk", "working"],
      });

      const reqWithNegativeTerms: MediaRequirement = {
        ...requirement,
        negativeTerms: ["cartoon", "drawing"],
      };

      const result = selector.select(
        reqWithNegativeTerms,
        discovery([cartoonCandidate, realisticCandidate]),
      );

      expect(result.status).toBe("selected");
      if (result.status === "selected") {
        expect(result.candidate.id).toBe("photo-desk-002");
      }
    });

    it("penalizes visual style mismatch when targetStyle is photographic", () => {
      const selector = new MediaCandidateSelector();

      const diagramCandidate = candidate("diagram-001", {
        description: "Diagram vector illustration of workspace",
        keywords: ["diagram", "vector", "illustration", "person", "desk"],
      });
      const photoCandidate = candidate("photo-002", {
        description: "Photo of modern office workspace",
        keywords: ["photograph", "photo", "person", "desk"],
      });

      const result = selector.select(
        requirement,
        discovery([diagramCandidate, photoCandidate]),
        {
          targetStyle: "photographic",
        },
      );

      expect(result.status).toBe("selected");
      if (result.status === "selected") {
        expect(result.candidate.id).toBe("photo-002");
      }
    });
  });
});
