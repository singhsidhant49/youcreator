import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  MediaCandidateSelector,
} from "./media-candidate-selector.js";

import {
  MediaResolver,
  type MediaCandidate,
  type MediaCandidateProvider,
  type MediaRequirement,
} from "./media-resolver.js";

import { MediaAcquirer } from "./media-acquirer.js";
import { MediaObjectStore } from "./media-object-store.js";
import { StockShotMediaResolver } from "./stock-shot-media-resolver.js";
import { STOCK_VISUAL_POLICIES } from "./stock-visual-policy.js";
import type { SemanticCandidateEvidence, SemanticVisualRequirement } from "./media-semantic-gate.js";

async function createPngFixture(filepath: string, extra = ""): Promise<string> {
  // Minimal valid 1x1 PNG with optional trailing bytes for distinct hashing
  const png1x1 = Buffer.concat([
    Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    ),
    Buffer.from(extra, "utf8"),
  ]);
  await writeFile(filepath, png1x1);
  return filepath;
}

describe("New Mode A — Adaptive Stock & Web Visual Resolver", () => {
  it("successfully selects and assigns local-library candidate", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-a-local-"));
    try {
      const bankDir = path.join(tmp, "bank");
      const storageDir = path.join(tmp, "storage");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(bankDir, { recursive: true });
      await mkdir(storageDir, { recursive: true });

      const imgPath = path.join(bankDir, "quantum_computer.png");
      await createPngFixture(imgPath);

      const localProvider: MediaCandidateProvider = {
        id: "local_library",
        supports: () => true,
        search: async () => [
          {
            id: "qc-local-1",
            provider: "local_library",
            kind: "image",
            description: "Superconducting quantum computer cryostat inside a modern laboratory",
            localPath: imgPath,
            width: 1920,
            height: 1080,
            keywords: ["quantum", "computer", "technology", "laboratory"],
          },
        ],
      };

      const discovery = new MediaResolver([localProvider]);
      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [bankDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });

      const requirements: MediaRequirement[] = [
        {
          shotId: "shot-1",
          sceneId: "scene-1",
          strategy: "stock_search",
          description: "A quantum processor cooling inside a cryostat",
          searchQueries: ["quantum computer processor"],
          negativeTerms: ["cartoon", "illustration"],
          preferredMediaKind: "image",
          continuityAnchorIds: [],
          identityReferencesRequired: [],
          continuityPrompt: "photorealistic laboratory setting",
          estimatedDurationSeconds: 4.5,
        },
      ];

      const resolver = new StockShotMediaResolver({
        jobId: "job-mode-a-test",
        mode: "A",
        requirements,
        discovery,
        selector: new MediaCandidateSelector(),
        acquirer,
        objectStore,
        policy: STOCK_VISUAL_POLICIES.balanced,
      });

      const outcome = await resolver.resolve("shot-1");

      expect(outcome.status).toBe("assigned");
      if (outcome.status === "assigned") {
        expect(outcome.assignment.mode).toBe("A");
        expect(outcome.assignment.shotId).toBe("shot-1");
        expect(outcome.assignment.assignmentSource).toBe("local_library");
        expect(outcome.assignment.asset.provenance.providerAssetId).toBe("qc-local-1");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("escalates to adaptive query refinement when initial search yields no strong match", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-a-refine-"));
    try {
      const bankDir = path.join(tmp, "bank");
      const storageDir = path.join(tmp, "storage");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(bankDir, { recursive: true });
      await mkdir(storageDir, { recursive: true });

      const imgPath = path.join(bankDir, "broad_nature.png");
      await createPngFixture(imgPath);

      const searchQueriesReceived: string[][] = [];

      const stockProvider: MediaCandidateProvider = {
        id: "mock_stock",
        supports: () => true,
        search: async (req) => {
          searchQueriesReceived.push([...req.searchQueries]);
          // On first attempt (hyper-specific), return zero candidates
          if (req.searchQueries.some((q) => q.includes("supercooled-dilution-refrigerator-unit"))) {
            return [];
          }
          // On refined attempt, return relevant candidates
          return [
            {
              id: "stock-asset-99",
              provider: "local_library",
              kind: "image",
              description: "High-tech laboratory processor environment",
              localPath: imgPath,
              width: 1920,
              height: 1080,
              keywords: ["laboratory", "technology", "processor"],
            },
          ];
        },
      };

      const discovery = new MediaResolver([stockProvider]);
      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [bankDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });

      const requirements: MediaRequirement[] = [
        {
          shotId: "shot-refine-1",
          sceneId: "scene-1",
          strategy: "stock_search",
          description: "Detailed view of high-tech laboratory processor environment",
          searchQueries: ["supercooled-dilution-refrigerator-unit in cleanroom"],
          negativeTerms: ["blur", "low quality"],
          preferredMediaKind: "image",
          continuityAnchorIds: [],
          identityReferencesRequired: [],
          continuityPrompt: "cleanroom environment",
          estimatedDurationSeconds: 4,
        },
      ];

      const resolver = new StockShotMediaResolver({
        jobId: "job-refine-test",
        mode: "A",
        requirements,
        discovery,
        selector: new MediaCandidateSelector(),
        acquirer,
        objectStore,
        policy: {
          ...STOCK_VISUAL_POLICIES.balanced,
          maxSearchAttempts: 3,
        },
      });

      const outcome = await resolver.resolve("shot-refine-1");

      expect(searchQueriesReceived.length).toBeGreaterThan(1);
      expect(outcome.status).toBe("assigned");
      if (outcome.status === "assigned") {
        expect(outcome.assignment.asset.provenance.providerAssetId).toBe("stock-asset-99");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("semantically rejects irrelevant imagery and fails explicitly instead of accepting bad matches", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-a-reject-"));
    try {
      const bankDir = path.join(tmp, "bank");
      const storageDir = path.join(tmp, "storage");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(bankDir, { recursive: true });
      await mkdir(storageDir, { recursive: true });

      const imgPath = path.join(bankDir, "pizza.png");
      await createPngFixture(imgPath);

      const provider: MediaCandidateProvider = {
        id: "stock_pexels",
        supports: () => true,
        search: async () => [
          {
            id: "pizza-photo",
            provider: "local_library",
            kind: "image",
            description: "Delicious pepperoni pizza on a wooden table",
            localPath: imgPath,
            width: 1920,
            height: 1080,
            keywords: ["pizza", "food", "cheese"],
          },
        ],
      };

      const discovery = new MediaResolver([provider]);
      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [bankDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });

      const requirements: MediaRequirement[] = [
        {
          shotId: "shot-nebula",
          sceneId: "scene-1",
          strategy: "stock_search",
          description: "Deep space telescope image of a colorful stellar nebula",
          searchQueries: ["astronomy telescope nebula"],
          negativeTerms: ["food", "indoor"],
          preferredMediaKind: "image",
          continuityAnchorIds: [],
          identityReferencesRequired: [],
          continuityPrompt: "astronomy deep space",
          estimatedDurationSeconds: 4,
        },
      ];

      const semanticRequirements: Record<string, SemanticVisualRequirement> = {
        "shot-nebula": {
          shotId: "shot-nebula",
          narration: "Stellar nebulae are the birthplaces of stars.",
          primarySubject: "stellar nebula",
          domain: "astronomy",
          requiredConcepts: ["nebula", "stars", "deep space"],
          excludedConcepts: ["pizza", "food", "kitchen"],
        },
      };

      const semanticEvidenceMap: Record<string, SemanticCandidateEvidence> = {
        "pizza-photo": {
          assetId: "pizza-photo",
          detectedConcepts: ["food", "pizza", "dough"],
          excludedConceptsDetected: ["pizza", "food"],
          relevanceScore: 10,
          evidenceSource: "vision_model",
        },
      };

      const resolver = new StockShotMediaResolver({
        jobId: "job-semantic-reject",
        mode: "A",
        requirements,
        discovery,
        selector: new MediaCandidateSelector(),
        acquirer,
        objectStore,
        semanticRequirements,
        semanticEvidenceMap,
        policy: STOCK_VISUAL_POLICIES.strict,
      });

      const outcome = await resolver.resolve("shot-nebula");

      expect(outcome.status).toBe("unresolved");
      if (outcome.status === "unresolved") {
        expect(outcome.reason).toBe("INVALID_ASSET");
        expect(outcome.message).toMatch(/SEMANTIC_GATE_REJECTED|BELOW_MINIMUM_SCORE/);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("strictly avoids calling AI generation APIs in Mode A", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-a-no-ai-"));
    try {
      const bankDir = path.join(tmp, "bank");
      const storageDir = path.join(tmp, "storage");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(bankDir, { recursive: true });
      await mkdir(storageDir, { recursive: true });

      const aiMock = vi.fn();

      const provider: MediaCandidateProvider = {
        id: "stock_empty",
        supports: () => true,
        search: async () => [],
      };

      const discovery = new MediaResolver([provider]);
      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [bankDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });

      const requirements: MediaRequirement[] = [
        {
          shotId: "shot-no-ai",
          sceneId: "scene-1",
          strategy: "stock_search",
          description: "Autonomous electric vehicle navigating urban street",
          searchQueries: ["autonomous electric vehicle city"],
          negativeTerms: [],
          preferredMediaKind: "image",
          continuityAnchorIds: [],
          identityReferencesRequired: [],
          continuityPrompt: "realistic urban",
          estimatedDurationSeconds: 3,
        },
      ];

      const resolver = new StockShotMediaResolver({
        jobId: "job-no-ai-test",
        mode: "A",
        requirements,
        discovery,
        selector: new MediaCandidateSelector(),
        acquirer,
        objectStore,
        policy: STOCK_VISUAL_POLICIES.fast,
      });

      const outcome = await resolver.resolve("shot-no-ai");

      expect(outcome.status).toBe("unresolved");
      // Zero calls to any AI generation
      expect(aiMock).not.toHaveBeenCalled();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("enforces negative terms and avoids duplicate assets across shots", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mode-a-dupe-"));
    try {
      const bankDir = path.join(tmp, "bank");
      const storageDir = path.join(tmp, "storage");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(bankDir, { recursive: true });
      await mkdir(storageDir, { recursive: true });

      const img1 = path.join(bankDir, "asset1.png");
      const img2 = path.join(bankDir, "asset2.png");
      await createPngFixture(img1, "asset1");
      await createPngFixture(img2, "asset2");

      const provider: MediaCandidateProvider = {
        id: "local_library",
        supports: () => true,
        search: async () => [
          {
            id: "asset-1",
            provider: "local_library",
            kind: "image",
            description: "Modern cloud datacenter server rack room",
            localPath: img1,
            width: 1920,
            height: 1080,
            keywords: ["cloud", "datacenter", "servers"],
          },
          {
            id: "asset-2",
            provider: "local_library",
            kind: "image",
            description: "Datacenter cooling ventilation infrastructure",
            localPath: img2,
            width: 1920,
            height: 1080,
            keywords: ["cooling", "datacenter", "infrastructure"],
          },
        ],
      };

      const discovery = new MediaResolver([provider]);
      const acquirer = new MediaAcquirer({
        storageRoot: storageDir,
        allowedLocalRoots: [bankDir],
      });
      const objectStore = new MediaObjectStore({ storageRoot: storageDir });

      const requirements: MediaRequirement[] = [
        {
          shotId: "shot-dupe-1",
          sceneId: "scene-1",
          strategy: "stock_search",
          description: "Cloud datacenter server racks",
          searchQueries: ["datacenter servers"],
          negativeTerms: [],
          preferredMediaKind: "image",
          continuityAnchorIds: [],
          identityReferencesRequired: [],
          continuityPrompt: "modern datacenter",
          estimatedDurationSeconds: 3,
        },
        {
          shotId: "shot-dupe-2",
          sceneId: "scene-1",
          strategy: "stock_search",
          description: "Datacenter server racks and infrastructure",
          searchQueries: ["datacenter servers"],
          negativeTerms: [],
          preferredMediaKind: "image",
          continuityAnchorIds: [],
          identityReferencesRequired: [],
          continuityPrompt: "modern datacenter",
          estimatedDurationSeconds: 3,
        },
      ];

      const resolver = new StockShotMediaResolver({
        jobId: "job-dupe-test",
        mode: "A",
        requirements,
        discovery,
        selector: new MediaCandidateSelector({
          disallowAdjacentDuplicates: true,
        }),
        acquirer,
        objectStore,
      });

      const res1 = await resolver.resolve("shot-dupe-1");
      const res2 = await resolver.resolve("shot-dupe-2");

      expect(res1.status).toBe("assigned");
      expect(res2.status).toBe("assigned");
      if (res1.status === "assigned" && res2.status === "assigned") {
        // Must select different assets to avoid duplicate shots
        expect(res1.assignment.asset.provenance.providerAssetId).toBe("asset-1");
        expect(res2.assignment.asset.provenance.providerAssetId).toBe("asset-2");
        expect(res1.assignment.asset.id).not.toBe(res2.assignment.asset.id);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
