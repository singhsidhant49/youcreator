import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ModeBAIShotMediaResolver } from "./mode-b-ai-resolver.js";
import { AIImageGenerationService } from "./ai-image-generation-service.js";
import { IdeogramImageProvider } from "./ideogram-image-provider.js";
import { MediaObjectStore } from "./media-object-store.js";
import { MediaUsageRightsStore } from "./media-usage-rights-store.js";
import type { MediaRequirement } from "./media-resolver.js";

function createValidPngBuffer(width = 1280, height = 720): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  return buf;
}

const mockRequirements: MediaRequirement[] = [
  {
    shotId: "shot-ai-1",
    sceneId: "scene-1",
    strategy: "ai_generation",
    description: "Photorealistic planetary view of Neptune with deep cobalt-blue clouds",
    searchQueries: [],
    negativeTerms: ["watermark", "text"],
    preferredMediaKind: "image",
    continuityAnchorIds: [],
    identityReferencesRequired: [],
    continuityPrompt: "Deep space cinematic shot of planet Neptune with vibrant blue atmosphere bands",
    estimatedDurationSeconds: 4.5,
  },
  {
    shotId: "shot-ai-2",
    sceneId: "scene-1",
    strategy: "ai_generation",
    description: "Close-up of Voyager space probe antenna navigating outer planetary space",
    searchQueries: [],
    negativeTerms: ["watermark"],
    preferredMediaKind: "image",
    continuityAnchorIds: [],
    identityReferencesRequired: [],
    continuityPrompt: "Detailed spacecraft instrumentation and gold records in outer solar system vacuum",
    estimatedDurationSeconds: 3.5,
  },
];

describe("ModeBAIShotMediaResolver Integration Tests", () => {
  let tempDir: string;
  let objectStore: MediaObjectStore;
  let rightsStore: MediaUsageRightsStore;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `youcreator-mode-b-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
    objectStore = new MediaObjectStore({ storageRoot: tempDir });
    rightsStore = new MediaUsageRightsStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves shots to Mode B AI assignments, writes content-addressed files, and records usage rights", async () => {
    const mockPng = createValidPngBuffer(1280, 720);
    const mockGenerateFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("v2/image/generate")) {
        return new Response(
          JSON.stringify({
            generation_id: "ideogram-gen-shot-1",
            seed: 9999,
            data: [
              {
                url: "https://ephemeral.ideogram.ai/images/shot-1.png",
                prompt: "Neptune view",
                resolution: "1280x720",
                is_image_safe: true,
                seed: 9999,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(new Uint8Array(mockPng), { status: 200, headers: { "Content-Type": "image/png" } });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockGenerateFetch as unknown as typeof fetch,
    });
    const aiService = new AIImageGenerationService([provider]);

    const resolver = new ModeBAIShotMediaResolver({
      jobId: "job-mode-b-test-1",
      storageRoot: tempDir,
      requirements: mockRequirements,
      aiService,
      objectStore,
      rightsStore,
      quality: "very_low",
      resolution: "1k",
      aspectRatio: "16x9",
    });

    const outcome = await resolver.resolve("shot-ai-1");

    expect(outcome.status).toBe("assigned");
    if (outcome.status !== "assigned") return;

    expect(outcome.assignment.mode).toBe("B");
    expect(outcome.assignment.assignmentSource).toBe("ai_generated");
    expect(outcome.assignment.shotId).toBe("shot-ai-1");
    expect(outcome.assignment.asset.width).toBe(1280);
    expect(outcome.assignment.asset.height).toBe(720);
    expect(outcome.assignment.asset.mimeType).toBe("image/png");

    // File was persisted into content-addressed location
    const storedBytes = await readFile(outcome.assignment.asset.localPath);
    expect(storedBytes.length).toBe(mockPng.length);

    // Object store lookup succeeds
    const lookedUp = await objectStore.lookup({
      provider: "ai_generated",
      id: outcome.assignment.asset.provenance.providerAssetId!,
    });
    expect(lookedUp).not.toBeNull();
    expect(lookedUp?.sha256).toBe(outcome.assignment.asset.sha256);

    // Usage rights recorded as approved commercial
    const assessment = await rightsStore.load({
      source: {
        provider: "ai_generated",
        id: outcome.assignment.asset.provenance.providerAssetId!,
      },
      assetHash: outcome.assignment.asset.sha256,
      intendedUse: "commercial_youtube",
      reviewer: "lookup-only",
      reviewedAt: "2026-01-01T00:00:00.000Z",
      commercialPermission: "unknown",
      personRelease: "unknown",
      propertyRelease: "unknown",
      attribution: "unknown",
      notes: "",
    });
    expect(assessment?.decision).toBe("approved");
  });

  it("reuses previously generated image without re-invoking the provider", async () => {
    let apiCallCount = 0;
    const mockPng = createValidPngBuffer(1280, 720);

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("v2/image/generate")) {
        apiCallCount++;
        return new Response(
          JSON.stringify({
            generation_id: "gen-reuse-1",
            data: [{ url: "https://ephemeral.ideogram.ai/reuse.png", is_image_safe: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(new Uint8Array(mockPng), { status: 200, headers: { "Content-Type": "image/png" } });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });
    const aiService = new AIImageGenerationService([provider]);

    const resolver = new ModeBAIShotMediaResolver({
      jobId: "job-reuse-test",
      storageRoot: tempDir,
      requirements: mockRequirements,
      aiService,
      objectStore,
      rightsStore,
      fixedSeed: 777,
    });

    // First resolve generates and persists
    const outcome1 = await resolver.resolve("shot-ai-1");
    expect(outcome1.status).toBe("assigned");
    expect(apiCallCount).toBe(1);

    // Second resolve reuses persisted asset without calling generate API!
    const outcome2 = await resolver.resolve("shot-ai-1");
    expect(outcome2.status).toBe("assigned");
    expect(apiCallCount).toBe(1); // ZERO additional API calls!

    if (outcome1.status === "assigned" && outcome2.status === "assigned") {
      expect(outcome2.assignment.asset.sha256).toBe(outcome1.assignment.asset.sha256);
      expect(outcome2.assignment.asset.localPath).toBe(outcome1.assignment.asset.localPath);
    }
  });

  it("enforces semantic QA gate and rejects mismatching concepts", async () => {
    const mockPng = createValidPngBuffer(1280, 720);
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("v2/image/generate")) {
        return new Response(
          JSON.stringify({
            generation_id: "gen-semantic-fail",
            data: [{ url: "https://ephemeral.ideogram.ai/sem.png", is_image_safe: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(new Uint8Array(mockPng), { status: 200, headers: { "Content-Type": "image/png" } });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });
    const aiService = new AIImageGenerationService([provider]);

    const resolver = new ModeBAIShotMediaResolver({
      jobId: "job-semantic-test",
      storageRoot: tempDir,
      requirements: mockRequirements,
      aiService,
      objectStore,
      rightsStore,
      semanticRequirements: {
        "shot-ai-1": {
          shotId: "shot-ai-1",
          narration: "Neptune winds",
          primarySubject: "Neptune",
          domain: "astronomy",
          requiredConcepts: ["deep blue atmosphere"],
          excludedConcepts: ["terrestrial oceans"],
        },
      },
      semanticEvidenceMap: {
        "shot-ai-1": {
          assetId: "any",
          detectedConcepts: ["terrestrial oceans"], // excluded concept present!
          excludedConceptsDetected: ["terrestrial oceans"],
          relevanceScore: 50,
          evidenceSource: "vision_model",
        },
      },
    });

    const outcome = await resolver.resolve("shot-ai-1");
    expect(outcome.status).toBe("unresolved");
    if (outcome.status === "unresolved") {
      expect(outcome.reason).toBe("INVALID_ASSET");
      expect(outcome.message).toContain("Semantic QA gate rejected");
    }
  });

  it("enforces job-level budget limit and stops further requests when limit reached", async () => {
    const mockPng = createValidPngBuffer(1280, 720);
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("v2/image/generate")) {
        return new Response(
          JSON.stringify({
            generation_id: "gen-budget-test",
            data: [{ url: "https://ephemeral.ideogram.ai/budget.png", is_image_safe: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(new Uint8Array(mockPng), { status: 200, headers: { "Content-Type": "image/png" } });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });
    const aiService = new AIImageGenerationService([provider]);

    const resolver = new ModeBAIShotMediaResolver({
      jobId: "job-budget-limit-test",
      storageRoot: tempDir,
      requirements: mockRequirements,
      aiService,
      objectStore,
      rightsStore,
      maxCostPerJobUsd: 0.002, // Lower than single shot cost of 0.003
    });

    const outcome1 = await resolver.resolve("shot-ai-1");
    expect(outcome1.status).toBe("assigned");

    // Second shot exceeds job budget
    const outcome2 = await resolver.resolve("shot-ai-2");
    expect(outcome2.status).toBe("unresolved");
    if (outcome2.status === "unresolved") {
      expect(outcome2.message).toContain("Mode B job cost limit reached");
    }
  });
});
