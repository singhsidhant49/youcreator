import { createHash } from "node:crypto";
import { z } from "zod";

import {
  inspectImageBytes,
} from "./media-image-probe.js";

const Sha256Schema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

export const AIImageProviderIdSchema = z.string()
  .regex(/^[a-zA-Z0-9_-]+$/);

export const AIImageReferenceSchema = z.object({
  id: z.string().min(1),
  sha256: Sha256Schema,
  mimeType: z.enum([
    "image/png",
    "image/jpeg",
  ]),
  bytes: z.number().int().positive(),

  // Local, verified reference files only.
  localPath: z.string().min(1),

  role: z.enum([
    "character",
    "style",
    "composition",
    "product",
  ]),
}).strict();

export const AIImageGenerationRequestSchema =
  z.object({
    shotId: z.string().min(1),

    prompt: z.string().trim().min(10),
    negativePrompt: z.string().optional(),

    provider: AIImageProviderIdSchema,
    model: z.string().trim().min(1),

    width: z.number().int().positive(),
    height: z.number().int().positive(),

    seed: z.number()
      .int()
      .nonnegative()
      .optional(),

    references: z.array(
      AIImageReferenceSchema,
    ).default([]),

    // Identifies the actual provider prompt template
    // and adapter behavior.
    promptVersion: z.string().trim().min(1),

    // Caller-supplied model-specific settings.
    settings: z.record(
      z.string(),
      z.union([
        z.string(),
        z.number().finite(),
        z.boolean(),
      ]),
    ).default({}),
  }).strict();

export type AIImageGenerationRequest =
  z.infer<typeof AIImageGenerationRequestSchema>;

export const AIImageUsageSchema = z.object({
  estimatedCostUsd: z.number()
    .finite()
    .nonnegative(),

  actualCostUsd: z.number()
    .finite()
    .nonnegative()
    .nullable(),

  billedImages: z.number()
    .int()
    .nonnegative(),
}).strict();

export type AIImageUsage = z.infer<
  typeof AIImageUsageSchema
>;

export interface AIImageProviderResult {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";

  providerRequestId?: string;
  revisedPrompt?: string;

  // Null when the provider cannot report actual cost.
  actualCostUsd: number | null;
}

export interface AIImageProvider {
  readonly id: string;

  supports(
    request: AIImageGenerationRequest,
  ): boolean;

  estimateCostUsd(
    request: AIImageGenerationRequest,
  ): number;

  generate(
    request: AIImageGenerationRequest,
  ): Promise<AIImageProviderResult>;
}

export const AIImageGenerationReceiptSchema = z.object({
  version: z.literal(1),

  generationKey: Sha256Schema,

  shotId: z.string().min(1),

  provider: AIImageProviderIdSchema,
  model: z.string().min(1),

  promptVersion: z.string().min(1),

  imageSha256: Sha256Schema,

  mimeType: z.enum([
    "image/png",
    "image/jpeg",
  ]),

  width: z.number().int().positive(),
  height: z.number().int().positive(),

  bytes: z.number().int().positive(),

  providerRequestId: z.string().optional(),
  revisedPrompt: z.string().optional(),

  usage: AIImageUsageSchema,

  generatedAt: z.string().datetime(),
}).strict();

export type AIImageGenerationReceipt = z.infer<
  typeof AIImageGenerationReceiptSchema
>;

export interface AIImageGenerationResult {
  imageBytes: Buffer;
  receipt: AIImageGenerationReceipt;
}

export function createAIImageGenerationKey(
  input: AIImageGenerationRequest,
): string {
  const request =
    AIImageGenerationRequestSchema.parse(input);

  const canonicalSettings = Object.fromEntries(
    Object.entries(request.settings)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  const identity = {
    version: 1,
    shotId: request.shotId,
    provider: request.provider,
    model: request.model,
    prompt: request.prompt,
    negativePrompt:
      request.negativePrompt ?? null,
    width: request.width,
    height: request.height,
    seed: request.seed ?? null,
    promptVersion: request.promptVersion,
    references: request.references,
    settings: canonicalSettings,
  };

  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}

export function hashGeneratedImage(
  bytes: Buffer,
): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}
