import { createHash } from "node:crypto";
import { z } from "zod";

import {
  VideoReleaseManifestSchema,
  verifyVideoReleaseManifest,
  type VideoReleaseManifest,
  type VerifiedReleaseEvidence,
} from "./video-release-manifest.js";

import {
  YoutubeMetadataInputSchema,
  normalizeYoutubeMetadata,
  youtubeMetadataHash,
  type YoutubeMetadataInput,
} from "./youtube-delivery-metadata.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const YoutubeDeliveryIntentSchema = z.object({
  channelId: z.string()
    .regex(/^UC[A-Za-z0-9_-]{22}$/),

  privacyStatus: z.enum([
    "private",
    "unlisted",
    "public",
  ]),

  madeForKids: z.boolean(),
  containsSyntheticMedia: z.boolean(),

  /**
   * Scheduling is deliberately excluded from
   * M9.2. M9.5 will own publishAt.
   */
}).strict();

export const YoutubeDeliveryPackageSchema = z.object({
  version: z.literal(1),
  provider: z.literal("youtube"),

  jobId: z.string().min(1),
  releaseHash: Hash,
  videoSha256: Hash,

  metadata: YoutubeMetadataInputSchema,
  metadataHash: Hash,

  intent: YoutubeDeliveryIntentSchema,

  packageHash: Hash,
}).strict();

export type YoutubeDeliveryIntent =
  z.infer<typeof YoutubeDeliveryIntentSchema>;

export type YoutubeDeliveryPackage =
  z.infer<typeof YoutubeDeliveryPackageSchema>;

export interface CreateYoutubeDeliveryPackageInput {
  release: VideoReleaseManifest;
  releaseEvidence: VerifiedReleaseEvidence;
  metadata: YoutubeMetadataInput;
  intent: YoutubeDeliveryIntent;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function createYoutubeDeliveryPackage(
  input: CreateYoutubeDeliveryPackageInput,
): YoutubeDeliveryPackage {
  const release = verifyVideoReleaseManifest(
    input.release,
    input.releaseEvidence,
  );

  const durationSeconds =
    release.totalFrames / release.fps;

  const metadata = normalizeYoutubeMetadata(
    input.metadata,
    durationSeconds,
  );

  const intent = YoutubeDeliveryIntentSchema.parse(
    input.intent,
  );

  const payload = {
    version: 1 as const,
    provider: "youtube" as const,
    jobId: release.jobId,
    releaseHash: release.releaseHash,
    videoSha256: release.videoSha256,
    metadata,
    metadataHash: youtubeMetadataHash(
      metadata,
    ),
    intent,
  };

  return YoutubeDeliveryPackageSchema.parse({
    ...payload,
    packageHash: hash(payload),
  });
}

export function verifyYoutubeDeliveryPackage(
  candidate: unknown,
  input: CreateYoutubeDeliveryPackageInput,
): YoutubeDeliveryPackage {
  const saved =
    YoutubeDeliveryPackageSchema.parse(
      candidate,
    );

  const expected =
    createYoutubeDeliveryPackage(input);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "M9 YouTube delivery package reconstruction mismatch",
    );
  }

  return saved;
}

/**
 * Provider-ready payload.
 *
 * Never includes file bytes or credentials.
 * Actual upload will be handled by M9.3/M9.4.
 */
export function toYoutubeInsertPayload(
  candidate: YoutubeDeliveryPackage,
) {
  const data =
    YoutubeDeliveryPackageSchema.parse(
      candidate,
    );

  const { metadata, intent } = data;

  return {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId,
      ...(metadata.defaultLanguage
        ? {
            defaultLanguage:
              metadata.defaultLanguage,
          }
        : {}),
    },
    status: {
      privacyStatus: intent.privacyStatus,
      selfDeclaredMadeForKids:
        intent.madeForKids,
      containsSyntheticMedia:
        intent.containsSyntheticMedia,
    },
  };
}
