import { describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "@youcreator/contracts";
import {
  MediaResolutionCoordinator,
  type ShotMediaResolver,
} from "./media-resolution-coordinator.js";
import type { MediaAssignmentOutcome } from "./assigned-media.js";
import { AIImageGenerationService } from "./ai-image-generation-service.js";
import type { AIImageProvider, AIImageGenerationRequest } from "./ai-image-generation.js";

import { createHash } from "node:crypto";

function createMockAsset(id: string): MediaAsset {
  const hash = createHash("sha256").update(id).digest("hex");
  return {
    version: 1,
    id: `asset-${id}`,
    kind: "image",
    localPath: `/storage/ai/${id}.png`,
    sha256: hash,
    bytes: 4096,
    mimeType: "image/png",
    width: 1920,
    height: 1080,
    provenance: {
      source: "ai_generated",
      providerAssetId: `gen-${id}`,
      license: {
        status: "unknown",
      },
    },
    createdAt: new Date().toISOString(),
  };
}

describe("New Mode B — AI-Generated Visuals Routing & Isolation", () => {
  it("routes canonical Mode B requests to AI resolver and preserves strict isolation from stock providers", async () => {
    const stockResolverFn = vi.fn();
    const aiResolverFn = vi.fn(async (shotId: string): Promise<MediaAssignmentOutcome> => ({
      status: "assigned",
      assignment: {
        version: 1,
        shotId,
        mode: "B",
        assignmentSource: "ai_generated",
        asset: createMockAsset(shotId),
        assignedAt: new Date().toISOString(),
      },
    }));

    const stockResolver: ShotMediaResolver = { resolve: stockResolverFn };
    const aiResolver: ShotMediaResolver = { resolve: aiResolverFn };

    const coordinator = new MediaResolutionCoordinator({
      manualShared: {
        assignSharedBackground: vi.fn(),
        assignManualMedia: vi.fn(),
      },
      stockResolver,
      aiResolver,
      assetVerifier: { verify: async () => true },
      rightsChecker: { check: async () => "approved" },
    });

    const report = await coordinator.run({
      version: 2,
      jobId: "job-ai-mode-b-1",
      mode: "B",
      shotIds: ["shot-ai-1", "shot-ai-2"],
      allowPaidGeneration: true,
    });

    expect(report.passed).toBe(true);
    expect(report.mode).toBe("B");
    expect(report.assignedShots).toBe(2);

    // AI resolver was called for all shots
    expect(aiResolverFn).toHaveBeenCalledTimes(2);
    expect(aiResolverFn).toHaveBeenCalledWith("shot-ai-1");
    expect(aiResolverFn).toHaveBeenCalledWith("shot-ai-2");

    // STRICT ISOLATION: Zero calls to stock resolver
    expect(stockResolverFn).not.toHaveBeenCalled();

    // Provenance preserved in assigned media
    expect(report.assignments[0]?.assignmentSource).toBe("ai_generated");
    expect(report.assignments[0]?.asset.provenance.source).toBe("ai_generated");
  });

  it("fails immediately when paid generation is not authorized in Mode B", async () => {
    const aiResolverFn = vi.fn();
    const stockResolverFn = vi.fn();

    const coordinator = new MediaResolutionCoordinator({
      manualShared: {
        assignSharedBackground: vi.fn(),
        assignManualMedia: vi.fn(),
      },
      stockResolver: { resolve: stockResolverFn },
      aiResolver: { resolve: aiResolverFn },
      assetVerifier: { verify: async () => true },
      rightsChecker: { check: async () => "approved" },
    });

    const report = await coordinator.run({
      version: 2,
      jobId: "job-ai-unauth",
      mode: "B",
      shotIds: ["shot-unauth-1"],
      allowPaidGeneration: false,
    });

    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.code === "RESOLUTION_FAILED" && i.message.includes("not authorized"))).toBe(true);
    // Resolver was not invoked
    expect(aiResolverFn).not.toHaveBeenCalled();
    // Strict isolation: stock was not invoked either
    expect(stockResolverFn).not.toHaveBeenCalled();
  });

  it("propagates AI provider failures appropriately with structured error reporting", async () => {
    const aiResolverFn = vi.fn(async (_shotId: string): Promise<MediaAssignmentOutcome> => ({
      status: "unresolved",
      shotId: "shot-fail-1",
      reason: "INVALID_ASSET",
      message: "AI provider rate limit exceeded (HTTP 429: Too Many Requests)",
    }));

    const stockResolverFn = vi.fn();

    const coordinator = new MediaResolutionCoordinator({
      manualShared: {
        assignSharedBackground: vi.fn(),
        assignManualMedia: vi.fn(),
      },
      stockResolver: { resolve: stockResolverFn },
      aiResolver: { resolve: aiResolverFn },
      assetVerifier: { verify: async () => true },
      rightsChecker: { check: async () => "approved" },
    });

    const report = await coordinator.run({
      version: 2,
      jobId: "job-ai-fail",
      mode: "B",
      shotIds: ["shot-fail-1"],
      allowPaidGeneration: true,
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.code).toBe("RESOLUTION_FAILED");
    expect(report.issues[0]?.message).toContain("HTTP 429");

    // Strict Mode B constraint: must not silently fall back to stock providers
    expect(stockResolverFn).not.toHaveBeenCalled();
  });

  it("AIImageGenerationService enforces cost budgets, validates dimensions, and tracks provider provenance", async () => {
    // Minimal valid 1x1 PNG bytes
    const png1x1 = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    );

    const mockProvider: AIImageProvider = {
      id: "mock_diffusion",
      supports: () => true,
      estimateCostUsd: () => 0.05,
      generate: async (req: AIImageGenerationRequest) => ({
        bytes: png1x1,
        mimeType: "image/png",
        providerRequestId: "req-123",
        revisedPrompt: `Enhanced: ${req.prompt}`,
        actualCostUsd: 0.045,
      }),
    };

    const service = new AIImageGenerationService([mockProvider], {
      maxCostPerImageUsd: 0.10,
    });

    const result = await service.generate({
      shotId: "shot-ai-gen-1",
      prompt: "Photorealistic futuristic server room with holographic displays",
      negativePrompt: "cartoon, blurry, low resolution",
      provider: "mock_diffusion",
      model: "diffusion-v3-hd",
      width: 1,
      height: 1,
      promptVersion: "v1.0",
      references: [],
      settings: {},
    });

    expect(result.receipt.shotId).toBe("shot-ai-gen-1");
    expect(result.receipt.provider).toBe("mock_diffusion");
    expect(result.receipt.model).toBe("diffusion-v3-hd");
    expect(result.receipt.usage.actualCostUsd).toBe(0.045);
    expect(result.receipt.imageSha256).toBeDefined();
    expect(result.imageBytes.length).toBeGreaterThan(0);

    // Over-budget test
    const expensiveProvider: AIImageProvider = {
      id: "expensive_provider",
      supports: () => true,
      estimateCostUsd: () => 0.50, // exceeds maxCostPerImageUsd (0.10)
      generate: async () => ({
        bytes: png1x1,
        mimeType: "image/png",
        actualCostUsd: 0.50,
      }),
    };

    const budgetConstrainedService = new AIImageGenerationService([expensiveProvider], {
      maxCostPerImageUsd: 0.10,
    });

    await expect(
      budgetConstrainedService.generate({
        shotId: "shot-budget-exceeded",
        prompt: "Ultra realistic cinematic explosion with volumetric smoke",
        provider: "expensive_provider",
        model: "expensive-model",
        width: 1,
        height: 1,
        promptVersion: "v1.0",
        references: [],
        settings: {},
      }),
    ).rejects.toThrow(/exceeds cost limit/);
  });
});
