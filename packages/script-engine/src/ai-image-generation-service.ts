import { z } from "zod";

import {
  AIImageGenerationRequestSchema,
  AIImageGenerationReceiptSchema,
  createAIImageGenerationKey,
  hashGeneratedImage,
  type AIImageProvider,
  type AIImageGenerationRequest,
  type AIImageGenerationResult,
} from "./ai-image-generation.js";

import {
  inspectImageBytes,
} from "./media-image-probe.js";

export interface AIImageGenerationServiceOptions {
  maxCostPerImageUsd?: number;
  maxImageBytes?: number;
  maxPixels?: number;
}

const ServiceOptionsSchema = z.object({
  maxCostPerImageUsd: z.number()
    .finite()
    .nonnegative()
    .default(0.15),

  maxImageBytes: z.number()
    .int()
    .positive()
    .default(15 * 1024 * 1024),

  maxPixels: z.number()
    .int()
    .positive()
    .default(50_000_000),
}).strict();

export class AIImageGenerationService {
  private readonly providers =
    new Map<string, AIImageProvider>();

  private readonly options: z.infer<
    typeof ServiceOptionsSchema
  >;

  constructor(
    providers: AIImageProvider[],
    options: AIImageGenerationServiceOptions = {},
  ) {
    this.options = ServiceOptionsSchema.parse(
      options,
    );

    for (const provider of providers) {
      if (
        !provider.id.trim() ||
        this.providers.has(provider.id)
      ) {
        throw new Error(
          "AI image providers require unique IDs",
        );
      }

      this.providers.set(
        provider.id,
        provider,
      );
    }
  }

  async generate(
    input: AIImageGenerationRequest,
  ): Promise<AIImageGenerationResult> {
    const request =
      AIImageGenerationRequestSchema.parse(input);

    const provider = this.providers.get(
      request.provider,
    );

    if (!provider) {
      throw new Error(
        `Unknown AI image provider: ${request.provider}`,
      );
    }

    if (!provider.supports(request)) {
      throw new Error(
        "AI image provider does not support request",
      );
    }

    const estimatedCost =
      provider.estimateCostUsd(request);

    if (
      !Number.isFinite(estimatedCost) ||
      estimatedCost < 0
    ) {
      throw new Error(
        "Invalid AI image generation cost estimate",
      );
    }

    if (
      estimatedCost >
      this.options.maxCostPerImageUsd
    ) {
      throw new Error(
        "AI image generation exceeds cost limit",
      );
    }

    const output = await provider.generate(
      request,
    );

    if (!Buffer.isBuffer(output.bytes)) {
      throw new Error(
        "AI provider did not return image bytes",
      );
    }

    if (
      output.bytes.length === 0 ||
      output.bytes.length >
        this.options.maxImageBytes
    ) {
      throw new Error(
        "Generated image exceeds permitted byte size",
      );
    }

    const inspected = inspectImageBytes(
      output.bytes,
      this.options.maxPixels,
    );

    if (
      inspected.mimeType !== output.mimeType
    ) {
      throw new Error(
        "Generated image MIME type mismatch",
      );
    }

    if (
      inspected.width !== request.width ||
      inspected.height !== request.height
    ) {
      throw new Error(
        "Generated image dimensions mismatch",
      );
    }

    if (
      output.actualCostUsd !== null &&
      (
        !Number.isFinite(output.actualCostUsd) ||
        output.actualCostUsd < 0
      )
    ) {
      throw new Error(
        "Invalid actual AI image generation cost",
      );
    }

    const receipt =
      AIImageGenerationReceiptSchema.parse({
        version: 1,

        generationKey:
          createAIImageGenerationKey(request),

        shotId: request.shotId,

        provider: request.provider,
        model: request.model,
        promptVersion: request.promptVersion,

        imageSha256:
          hashGeneratedImage(output.bytes),

        mimeType: inspected.mimeType,
        width: inspected.width,
        height: inspected.height,
        bytes: output.bytes.length,

        ...(output.providerRequestId
          ? {
              providerRequestId:
                output.providerRequestId,
            }
          : {}),

        ...(output.revisedPrompt
          ? {
              revisedPrompt:
                output.revisedPrompt,
            }
          : {}),

        usage: {
          estimatedCostUsd: estimatedCost,
          actualCostUsd:
            output.actualCostUsd,
          billedImages: 1,
        },

        generatedAt:
          new Date().toISOString(),
      });

    return {
      imageBytes: output.bytes,
      receipt,
    };
  }
}
