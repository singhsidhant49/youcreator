import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createAIImageGenerationKey,
  type AIImageGenerationRequest,
  type AIImageProvider,
} from "./ai-image-generation.js";

import {
  AIImageGenerationService,
} from "./ai-image-generation-service.js";

function pngBytes(
  width = 1024,
  height = 1024,
): Buffer {
  const bytes = Buffer.alloc(33);

  Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]).copy(bytes, 0);

  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");

  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);

  bytes[24] = 8;
  bytes[25] = 2;

  return bytes;
}

const request: AIImageGenerationRequest = {
  shotId: "shot-001",

  prompt:
    "Cinematic photograph of a person working at a desk",

  provider: "mock-provider",
  model: "mock-image-model",

  width: 1024,
  height: 1024,

  promptVersion: "ai-visual-v1",

  references: [],
  settings: {
    quality: "medium",
  },
};

function createProvider(
  overrides: Partial<AIImageProvider> = {},
): AIImageProvider {
  return {
    id: "mock-provider",

    supports: () => true,

    estimateCostUsd: () => 0.04,

    generate: vi.fn(async () => ({
      bytes: pngBytes(),
      mimeType: "image/png" as const,
      actualCostUsd: 0.04,
      providerRequestId: "mock-request-001",
    })),

    ...overrides,
  };
}

describe("AI image generation", () => {
  it("creates a stable generation identity", () => {
    expect(
      createAIImageGenerationKey(request),
    ).toBe(
      createAIImageGenerationKey({
        ...request,
      }),
    );
  });

  it("invalidates identity when the prompt changes", () => {
    expect(
      createAIImageGenerationKey(request),
    ).not.toBe(
      createAIImageGenerationKey({
        ...request,
        prompt:
          "Cinematic portrait of an astronaut in space",
      }),
    );
  });

  it("invalidates identity when model or settings change", () => {
    const original =
      createAIImageGenerationKey(request);

    expect(original).not.toBe(
      createAIImageGenerationKey({
        ...request,
        model: "another-model",
      }),
    );

    expect(original).not.toBe(
      createAIImageGenerationKey({
        ...request,
        settings: {
          quality: "high",
        },
      }),
    );
  });

  it("generates and verifies a mock image", async () => {
    const service = new AIImageGenerationService([
      createProvider(),
    ]);

    const result = await service.generate(
      request,
    );

    expect(result.receipt).toMatchObject({
      version: 1,
      provider: "mock-provider",
      model: "mock-image-model",
      width: 1024,
      height: 1024,

      usage: {
        estimatedCostUsd: 0.04,
        actualCostUsd: 0.04,
        billedImages: 1,
      },
    });

    expect(
      result.receipt.imageSha256,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects estimated costs above the budget before invoking the provider", async () => {
    const generate = vi.fn(async () => ({
      bytes: pngBytes(),
      mimeType: "image/png" as const,
      actualCostUsd: 0.2,
    }));

    const service = new AIImageGenerationService(
      [
        createProvider({
          estimateCostUsd: () => 0.2,
          generate,
        }),
      ],
      {
        maxCostPerImageUsd: 0.05,
      },
    );

    await expect(
      service.generate(request),
    ).rejects.toThrow(
      "exceeds cost limit",
    );

    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects providers that do not support the request", async () => {
    const service = new AIImageGenerationService([
      createProvider({
        supports: () => false,
      }),
    ]);

    await expect(
      service.generate(request),
    ).rejects.toThrow(
      "does not support request",
    );
  });

  it("rejects generated images with mismatched dimensions", async () => {
    const service = new AIImageGenerationService([
      createProvider({
        generate: async () => ({
          bytes: pngBytes(512, 512),
          mimeType: "image/png",
          actualCostUsd: 0.04,
        }),
      }),
    ]);

    await expect(
      service.generate(request),
    ).rejects.toThrow(
      "dimensions mismatch",
    );
  });

  it("rejects unsupported or corrupt image bytes", async () => {
    const service = new AIImageGenerationService([
      createProvider({
        generate: async () => ({
          bytes: Buffer.from("not an image"),
          mimeType: "image/png",
          actualCostUsd: null,
        }),
      }),
    ]);

    await expect(
      service.generate(request),
    ).rejects.toThrow(
      "Unsupported image format",
    );
  });

  it("rejects duplicate provider identifiers", () => {
    expect(() =>
      new AIImageGenerationService([
        createProvider(),
        createProvider(),
      ]),
    ).toThrow(
      "unique IDs",
    );
  });
});
