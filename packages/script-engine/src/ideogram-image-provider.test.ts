import { describe, expect, it, vi } from "vitest";

import {
  IdeogramImageProvider,
  normalizeIdeogramAspectRatio,
  getIdeogramExpectedDimensions,
  IDEOGRAM_PRICING_TABLE,
} from "./ideogram-image-provider.js";

import type { AIImageGenerationRequest } from "./ai-image-generation.js";

function createValidPngBuffer(width = 1280, height = 720): Buffer {
  const buf = Buffer.alloc(33);
  // PNG signature
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type (RGB)
  return buf;
}

const mockRequest: AIImageGenerationRequest = {
  shotId: "shot-001",
  prompt: "Photorealistic cinematic view of Neptune from space with atmospheric bands",
  negativePrompt: "text, watermark",
  provider: "ideogram",
  model: "p-image-ideogram",
  width: 1280,
  height: 720,
  promptVersion: "v1",
  references: [],
  settings: {
    quality: "very_low",
    resolution: "1k",
    aspectRatio: "16x9",
  },
  seed: 4242,
};

describe("IdeogramImageProvider Unit Tests", () => {
  it("normalizes aspect ratios with colons and validates expected dimensions", () => {
    expect(normalizeIdeogramAspectRatio("16:9")).toBe("16x9");
    expect(normalizeIdeogramAspectRatio("1:1")).toBe("1x1");
    expect(normalizeIdeogramAspectRatio("9:16")).toBe("9x16");
    expect(normalizeIdeogramAspectRatio("4:3")).toBe("4x3");
    expect(normalizeIdeogramAspectRatio("invalid")).toBe("16x9");

    expect(getIdeogramExpectedDimensions("1k", "16:9")).toEqual({ width: 1280, height: 720 });
    expect(getIdeogramExpectedDimensions("1k", "1:1")).toEqual({ width: 1024, height: 1024 });
    expect(getIdeogramExpectedDimensions("2k", "16:9")).toEqual({ width: 2560, height: 1440 });
  });

  it("calculates cost estimates matching official Ideogram published pricing", () => {
    const provider = new IdeogramImageProvider({ apiKey: "test-key" });

    // p-image-ideogram very_low = $0.003
    expect(provider.estimateCostUsd(mockRequest)).toBe(0.003);

    // p-image-ideogram medium = $0.010
    expect(
      provider.estimateCostUsd({
        ...mockRequest,
        settings: { quality: "medium" },
      }),
    ).toBe(0.010);

    // p-image-ideogram 2k tier doubles price
    expect(
      provider.estimateCostUsd({
        ...mockRequest,
        settings: { quality: "very_low", resolution: "2k" },
      }),
    ).toBe(0.006);
  });

  it("constructs correct Ideogram v2 API request with Api-Key and required payload", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockPng = createValidPngBuffer(1280, 720);

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("api.ideogram.ai/v2/image/generate")) {
        capturedUrl = urlStr;
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = JSON.parse(init?.body as string);

        return new Response(
          JSON.stringify({
            generation_id: "gen-ideogram-123",
            seed: 4242,
            data: [
              {
                url: "https://ephemeral.ideogram.ai/images/temp-123.png",
                prompt: capturedBody.prompt,
                resolution: "1280x720",
                is_image_safe: true,
                seed: 4242,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("ephemeral.ideogram.ai")) {
        return new Response(new Uint8Array(mockPng), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "secret-ideogram-test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.generate(mockRequest);

    // Verify endpoint & headers
    expect(capturedUrl).toBe("https://api.ideogram.ai/v2/image/generate/p-image-ideogram");
    expect(capturedHeaders["Api-Key"]).toBe("secret-ideogram-test-key");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");

    // Verify payload fields
    expect(capturedBody.prompt).toBe(mockRequest.prompt);
    expect(capturedBody.quality).toBe("very_low");
    expect(capturedBody.resolution).toBe("1k");
    expect(capturedBody.aspect_ratio).toBe("16x9");
    expect(capturedBody.num_images).toBe(1);
    expect(capturedBody.magic_prompt).toBe("off");
    expect(capturedBody.seed).toBe(4242);

    // Verify downloaded result
    expect(result.mimeType).toBe("image/png");
    expect(result.providerRequestId).toBe("gen-ideogram-123");
    expect(result.actualCostUsd).toBe(0.003);
    expect(result.bytes.length).toBe(mockPng.length);
  });

  it("supports dry-run pricing quotes via getPriceQuote", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      expect(urlStr).toContain("dry_run=true");
      return new Response(
        JSON.stringify({
          object: "price_quote",
          billing_identifier: "p_image_ideogram_generation",
          quantity: 1,
          usd_micros: 3000,
          credit_millis: 300,
          qualifier: "exact",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });

    const quote = await provider.getPriceQuote(mockRequest);
    expect(quote.object).toBe("price_quote");
    expect(quote.usdCost).toBe(0.003);
    expect(quote.usdMicros).toBe(3000);
    expect(quote.qualifier).toBe("exact");
  });

  it("enforces maximum cost limit per image", async () => {
    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      maxCostPerImageUsd: 0.002, // Lower than 0.003
    });

    await expect(provider.generate(mockRequest)).rejects.toThrow(/exceeds maximum permitted/);
  });

  it("handles authentication failure (HTTP 401) with clean error", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "Invalid API Token" }), { status: 401 });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "bad-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generate(mockRequest)).rejects.toThrow(/Ideogram authentication failed/);
  });

  it("handles insufficient funds / payment required (HTTP 402)", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "Insufficient credits", reject_reason: "insufficient_funds" }),
        { status: 402 },
      );
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generate(mockRequest)).rejects.toThrow(/insufficient funds or quota exceeded/);
  });

  it("handles prompt safety filter rejection (HTTP 422)", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ detail: "Prompt violated safety guidelines" }), { status: 422 });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generate(mockRequest)).rejects.toThrow(/prompt rejected by safety filter/);
  });

  it("retries on transient rate limits (HTTP 429) up to retry limit", async () => {
    let callCount = 0;
    const mockPng = createValidPngBuffer(1280, 720);

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("v2/image/generate")) {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 });
        }
        return new Response(
          JSON.stringify({
            generation_id: "retry-gen-id",
            seed: 1234,
            data: [
              {
                url: "https://ephemeral.ideogram.ai/images/retry.png",
                is_image_safe: true,
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
      maxRetries: 2,
      retryDelayMs: 10,
      httpClient: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.generate(mockRequest);
    expect(callCount).toBe(2);
    expect(result.providerRequestId).toBe("retry-gen-id");
  });

  it("rejects when image is flagged as unsafe by Ideogram", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          generation_id: "unsafe-gen",
          data: [{ url: null, is_image_safe: false }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generate(mockRequest)).rejects.toThrow(/failed Ideogram safety checks/);
  });

  it("rejects when ephemeral image download fails (e.g. expired URL)", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("v2/image/generate")) {
        return new Response(
          JSON.stringify({
            generation_id: "expired-test",
            data: [{ url: "https://ephemeral.ideogram.ai/expired.png", is_image_safe: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Expired", { status: 410 });
    });

    const provider = new IdeogramImageProvider({
      apiKey: "test-key",
      httpClient: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generate(mockRequest)).rejects.toThrow(/Failed to download generated image/);
  });
});
