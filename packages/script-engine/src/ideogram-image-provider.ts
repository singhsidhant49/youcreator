import { createHash } from "node:crypto";
import { z } from "zod";

import {
  type AIImageProvider,
  type AIImageGenerationRequest,
  type AIImageProviderResult,
} from "./ai-image-generation.js";

import {
  inspectImageBytes,
} from "./media-image-probe.js";

export const IdeogramQualitySchema = z.enum([
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
]);

export type IdeogramQuality = z.infer<typeof IdeogramQualitySchema>;

export const IdeogramResolutionSchema = z.enum([
  "1k",
  "2k",
]);

export type IdeogramResolution = z.infer<typeof IdeogramResolutionSchema>;

export const IdeogramAspectRatioSchema = z.enum([
  "1x3",
  "3x1",
  "1x2",
  "2x1",
  "9x16",
  "16x9",
  "10x16",
  "16x10",
  "2x3",
  "3x2",
  "3x4",
  "4x3",
  "4x5",
  "5x4",
  "1x1",
]);

export type IdeogramAspectRatio = z.infer<typeof IdeogramAspectRatioSchema>;

/**
 * Standard published pricing for Ideogram models (USD per image).
 */
export const IDEOGRAM_PRICING_TABLE: Record<string, Record<string, number>> = {
  "p-image-ideogram": {
    very_low: 0.003,
    low: 0.006,
    medium: 0.010,
    high: 0.020,
    very_high: 0.040,
  },
  "ideogram-4": {
    turbo: 0.030,
    default: 0.060,
  },
  "ideogram-4-5": {
    very_low: 0.008,
    low: 0.030,
    medium: 0.060,
  },
};

/**
 * Standard output dimensions mapped by resolution tier and aspect ratio.
 */
export const IDEOGRAM_DIMENSIONS_TABLE: Record<string, Record<string, { width: number; height: number }>> = {
  "1k": {
    "16x9": { width: 1280, height: 720 },
    "1x1": { width: 1024, height: 1024 },
    "9x16": { width: 720, height: 1280 },
    "4x3": { width: 1152, height: 864 },
    "3x4": { width: 864, height: 1152 },
    "3x2": { width: 1216, height: 832 },
    "2x3": { width: 832, height: 1216 },
    "16x10": { width: 1280, height: 800 },
    "10x16": { width: 800, height: 1280 },
    "2x1": { width: 1408, height: 704 },
    "1x2": { width: 704, height: 1408 },
    "3x1": { width: 1536, height: 512 },
    "1x3": { width: 512, height: 1536 },
    "5x4": { width: 1120, height: 896 },
    "4x5": { width: 896, height: 1120 },
  },
  "2k": {
    "16x9": { width: 2560, height: 1440 },
    "1x1": { width: 2048, height: 2048 },
    "9x16": { width: 1440, height: 2560 },
  },
};

export function normalizeIdeogramAspectRatio(input: string): IdeogramAspectRatio {
  const normalized = input.trim().replace(":", "x").toLowerCase();
  const parsed = IdeogramAspectRatioSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }
  return "16x9";
}

export function getIdeogramExpectedDimensions(
  resolution = "1k",
  aspectRatio = "16x9",
): { width: number; height: number } {
  const normRatio = normalizeIdeogramAspectRatio(aspectRatio);
  const tier = IDEOGRAM_DIMENSIONS_TABLE[resolution] ?? IDEOGRAM_DIMENSIONS_TABLE["1k"]!;
  return tier[normRatio] ?? { width: 1280, height: 720 };
}

export interface IdeogramImageProviderOptions {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultQuality?: IdeogramQuality;
  defaultResolution?: IdeogramResolution;
  defaultAspectRatio?: IdeogramAspectRatio | string;
  magicPrompt?: "auto" | "on" | "off";
  maxCostPerImageUsd?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  httpClient?: typeof fetch;
}

export interface IdeogramPriceQuote {
  object: "price_quote";
  billingIdentifier: string;
  quantity: number;
  usdMicros: number;
  usdCost: number;
  creditMillis: number;
  qualifier: string;
}

export interface IdeogramImageObject {
  url?: string | null;
  prompt?: string;
  resolution?: string;
  is_image_safe?: boolean;
  seed?: number;
}

export interface IdeogramGenerateResponse {
  generation_id?: string;
  seed?: number;
  data?: IdeogramImageObject[];
}

export class IdeogramImageProvider implements AIImageProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultQuality: IdeogramQuality;
  private readonly defaultResolution: IdeogramResolution;
  private readonly defaultAspectRatio: IdeogramAspectRatio;
  private readonly magicPrompt: "auto" | "on" | "off";
  private readonly maxCostPerImageUsd: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly httpClient: typeof fetch;

  constructor(options: IdeogramImageProviderOptions = {}) {
    this.id = options.id ?? "ideogram";
    this.apiKey = options.apiKey ?? process.env.IDEOGRAM_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.ideogram.ai").replace(/\/+$/, "");
    this.defaultModel = options.defaultModel ?? process.env.IDEOGRAM_MODEL ?? "p-image-ideogram";
    this.defaultQuality = options.defaultQuality ?? (process.env.IDEOGRAM_QUALITY as IdeogramQuality | undefined) ?? "very_low";
    this.defaultResolution = options.defaultResolution ?? (process.env.IDEOGRAM_RESOLUTION as IdeogramResolution | undefined) ?? "1k";
    this.defaultAspectRatio = normalizeIdeogramAspectRatio(options.defaultAspectRatio ?? process.env.IDEOGRAM_ASPECT_RATIO ?? "16x9");
    this.magicPrompt = options.magicPrompt ?? "off";
    this.maxCostPerImageUsd = options.maxCostPerImageUsd ?? 0.15;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.httpClient = options.httpClient ?? fetch;
  }

  supports(request: AIImageGenerationRequest): boolean {
    const providerMatches = request.provider === this.id || request.provider === "ideogram";
    const supportedModels = ["p-image-ideogram", "ideogram-4", "ideogram-4-5"];
    const modelMatches = supportedModels.includes(request.model) || request.model === this.defaultModel;
    return providerMatches && modelMatches;
  }

  estimateCostUsd(request: AIImageGenerationRequest): number {
    const model = request.model || this.defaultModel;
    const qualitySetting = typeof request.settings.quality === "string"
      ? request.settings.quality
      : this.defaultQuality;

    const modelTable = IDEOGRAM_PRICING_TABLE[model];
    if (modelTable && qualitySetting in modelTable) {
      const baseCost = modelTable[qualitySetting]!;
      // 2k resolution tier doubles unit price
      const resolution = typeof request.settings.resolution === "string"
        ? request.settings.resolution
        : this.defaultResolution;
      return resolution === "2k" ? baseCost * 2 : baseCost;
    }

    // Default very_low p-image-ideogram fallback
    return 0.003;
  }

  /**
   * Fetches an official dry-run pricing quote from Ideogram API.
   * Sends dry_run=true, verifying the exact payload without charging credits or generating images.
   */
  async getPriceQuote(request: Partial<AIImageGenerationRequest>): Promise<IdeogramPriceQuote> {
    if (!this.apiKey) {
      throw new Error("IDEOGRAM_API_KEY is required for price quotes");
    }

    const payload = this.buildPayload({
      shotId: request.shotId ?? "quote-shot",
      prompt: request.prompt ?? "A price quote prompt for landscape 16:9 illustration",
      provider: this.id,
      model: request.model ?? this.defaultModel,
      width: request.width ?? 1280,
      height: request.height ?? 720,
      promptVersion: request.promptVersion ?? "v1",
      references: [],
      settings: request.settings ?? {},
      seed: request.seed,
    });

    const endpoint = request.model ?? this.defaultModel;
    const url = `${this.baseUrl}/v2/image/generate/${endpoint}?dry_run=true`;

    const response = await this.httpClient(url, {
      method: "POST",
      headers: {
        "Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Ideogram dry-run quote failed HTTP ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      object: "price_quote";
      billing_identifier: string;
      quantity: number;
      usd_micros: number;
      credit_millis: number;
      qualifier: string;
    };

    return {
      object: "price_quote",
      billingIdentifier: data.billing_identifier,
      quantity: data.quantity,
      usdMicros: data.usd_micros,
      usdCost: data.usd_micros / 1_000_000,
      creditMillis: data.credit_millis,
      qualifier: data.qualifier,
    };
  }

  private buildPayload(request: AIImageGenerationRequest): Record<string, unknown> {
    const quality = typeof request.settings.quality === "string"
      ? (IdeogramQualitySchema.safeParse(request.settings.quality).data ?? this.defaultQuality)
      : this.defaultQuality;

    const resolution = typeof request.settings.resolution === "string"
      ? (IdeogramResolutionSchema.safeParse(request.settings.resolution).data ?? this.defaultResolution)
      : this.defaultResolution;

    const rawAspect = typeof request.settings.aspectRatio === "string"
      ? request.settings.aspectRatio
      : this.defaultAspectRatio;
    const aspectRatio = normalizeIdeogramAspectRatio(rawAspect);

    const magicPrompt = typeof request.settings.magicPrompt === "string" && ["auto", "on", "off"].includes(request.settings.magicPrompt)
      ? request.settings.magicPrompt
      : this.magicPrompt;

    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      magic_prompt: magicPrompt,
      num_images: 1,
      quality,
      resolution,
      aspect_ratio: aspectRatio,
    };

    if (request.seed !== undefined && Number.isInteger(request.seed)) {
      payload.seed = request.seed;
    }

    return payload;
  }

  async generate(request: AIImageGenerationRequest): Promise<AIImageProviderResult> {
    if (!this.apiKey) {
      throw new Error("IDEOGRAM_API_KEY is required to generate images");
    }

    const estimatedCost = this.estimateCostUsd(request);
    if (estimatedCost > this.maxCostPerImageUsd) {
      throw new Error(
        `Estimated image cost $${estimatedCost.toFixed(4)} exceeds maximum permitted $${this.maxCostPerImageUsd.toFixed(4)}`,
      );
    }

    const endpoint = request.model || this.defaultModel;
    const url = `${this.baseUrl}/v2/image/generate/${endpoint}`;
    const payload = this.buildPayload(request);

    let lastError: Error | null = null;
    let responseData: IdeogramGenerateResponse | null = null;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        const response = await this.httpClient(url, {
          method: "POST",
          headers: {
            "Api-Key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          const status = response.status;
          let bodyText = "";
          try {
            bodyText = await response.text();
          } catch {
            bodyText = "(no response body)";
          }

          if (status === 401) {
            throw new Error(`Ideogram authentication failed: Invalid or missing Api-Key (HTTP 401)`);
          }
          if (status === 402) {
            throw new Error(`Ideogram insufficient funds or quota exceeded: ${bodyText} (HTTP 402)`);
          }
          if (status === 422) {
            throw new Error(`Ideogram prompt rejected by safety filter: ${bodyText} (HTTP 422)`);
          }
          if (status === 429 || status >= 500) {
            // Transient rate limit or server error - retry if attempts remain
            if (attempt <= this.maxRetries) {
              const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
          }

          throw new Error(`Ideogram API failed with HTTP ${status}: ${bodyText}`);
        }

        responseData = (await response.json()) as IdeogramGenerateResponse;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt > this.maxRetries || lastError.message.includes("HTTP 401") || lastError.message.includes("HTTP 402") || lastError.message.includes("HTTP 422")) {
          throw lastError;
        }
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!responseData) {
      throw lastError ?? new Error("Failed to receive response from Ideogram API");
    }

    if (!responseData.data || responseData.data.length === 0) {
      throw new Error("Ideogram API returned an empty image data array");
    }

    const firstImage = responseData.data[0]!;
    if (firstImage.is_image_safe === false) {
      throw new Error("Generated image failed Ideogram safety checks and was suppressed");
    }

    if (!firstImage.url) {
      throw new Error("Ideogram API returned image with no download URL");
    }

    // Download the ephemeral image bytes before expiration
    const imageResponse = await this.httpClient(firstImage.url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!imageResponse.ok) {
      throw new Error(`Failed to download generated image from ephemeral URL: HTTP ${imageResponse.status}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    if (bytes.length === 0) {
      throw new Error("Downloaded image payload is empty (0 bytes)");
    }

    // Probe and verify image bytes
    const inspected = inspectImageBytes(bytes, 50_000_000);

    return {
      bytes,
      mimeType: inspected.mimeType,
      providerRequestId: responseData.generation_id,
      revisedPrompt: firstImage.prompt,
      actualCostUsd: estimatedCost,
    };
  }
}
