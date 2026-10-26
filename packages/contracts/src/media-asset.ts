import { z } from "zod";

const Sha256Schema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

const IdSchema = z.string().regex(
  /^[a-zA-Z0-9_-]+$/,
);

export const MediaAssetKindSchema = z.enum([
  "image",
  "video",
]);

export const MediaSourceSchema = z.enum([
  "local_library",
  "pexels",
  "wikimedia",
  "other_stock",
  "ai_generated",
  "manual_upload",
  "shared_background",
]);

export const MediaLicenseStatusSchema = z.enum([
  "unknown",
  "review_required",
  "verified",
  "restricted",
]);

export const MediaLicenseSchema = z.object({
  status: MediaLicenseStatusSchema,

  // License label as supplied by the provider.
  licenseName: z.string().optional(),

  licenseUrl: z.string().url().optional(),

  attributionRequired: z.boolean().optional(),

  attributionText: z.string().optional(),

  // Records supporting a verification decision.
  verifiedAt: z.string().datetime().optional(),
  evidenceUrl: z.string().url().optional(),
}).strict().superRefine((license, context) => {
  if (
    license.status === "verified" &&
    (!license.verifiedAt || !license.evidenceUrl)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Verified licenses require time and evidence",
    });
  }
});

export const MediaProvenanceSchema = z.object({
  source: MediaSourceSchema,

  providerAssetId: z.string().optional(),

  originalUrl: z.string().url().optional(),

  creator: z.string().optional(),

  retrievedAt: z.string().datetime().optional(),

  // Provenance records are not license approval.
  license: MediaLicenseSchema,
}).strict();

export const MediaAssetSchema = z.object({
  version: z.literal(1),

  id: IdSchema,

  kind: MediaAssetKindSchema,

  // Must reference actual locally stored bytes.
  localPath: z.string().min(1),

  sha256: Sha256Schema,

  bytes: z.number().int().positive(),

  mimeType: z.string().min(3),

  width: z.number().int().positive(),
  height: z.number().int().positive(),

  // Required for video, omitted for images.
  durationSeconds: z.number().positive().optional(),

  provenance: MediaProvenanceSchema,

  createdAt: z.string().datetime(),
}).strict().superRefine((asset, context) => {
  if (
    asset.kind === "video" &&
    asset.durationSeconds === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Video assets require duration",
      path: ["durationSeconds"],
    });
  }

  if (
    asset.kind === "image" &&
    asset.durationSeconds !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Image assets cannot have duration",
      path: ["durationSeconds"],
    });
  }
});

export const MediaResolutionFailureCodeSchema = z.enum([
  "NO_MATCH",
  "LOW_RELEVANCE",
  "PROVIDER_ERROR",
  "DOWNLOAD_FAILED",
  "INTEGRITY_FAILED",
  "LICENSE_UNAVAILABLE",
  "IDENTITY_UNSATISFIED",
  "MANUAL_ASSET_REQUIRED",
  "UNSUPPORTED_MEDIA",
]);

export const MediaResolutionResultSchema =
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("resolved"),
      shotId: IdSchema,
      asset: MediaAssetSchema,
      matchScore: z.number().min(0).max(1),
    }).strict(),

    z.object({
      status: z.literal("unresolved"),
      shotId: IdSchema,
      code: MediaResolutionFailureCodeSchema,
      reason: z.string().min(1),
      retryable: z.boolean(),
    }).strict(),
  ]);

export const MediaResolutionBatchSchema = z.object({
  version: z.literal(1),
  jobId: IdSchema,

  results: z.array(
    MediaResolutionResultSchema,
  ),

  createdAt: z.string().datetime(),
}).strict();

export type MediaAsset = z.infer<
  typeof MediaAssetSchema
>;

export type MediaProvenance = z.infer<
  typeof MediaProvenanceSchema
>;

export type MediaResolutionResult = z.infer<
  typeof MediaResolutionResultSchema
>;

export type MediaResolutionBatch = z.infer<
  typeof MediaResolutionBatchSchema
>;
