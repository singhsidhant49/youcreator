import { describe, expect, it } from "vitest";

import {
  MediaAssetSchema,
  MediaResolutionBatchSchema,
  MediaResolutionResultSchema,
} from "./media-asset.js";

const now = "2026-10-12T10:00:00.000Z";

const image = {
  version: 1 as const,
  id: "asset-001",
  kind: "image" as const,

  localPath: "/tmp/youcreator/image.png",

  sha256: "a".repeat(64),
  bytes: 2048,
  mimeType: "image/png",

  width: 1920,
  height: 1080,

  provenance: {
    source: "local_library" as const,
    providerAssetId: "library-001",
    license: {
      status: "unknown" as const,
    },
  },

  createdAt: now,
};

describe("Media asset contracts", () => {
  it("validates image asset metadata", () => {
    const result = MediaAssetSchema.parse(image);

    expect(result.kind).toBe("image");
    expect(result.width).toBe(1920);
  });

  it("requires a duration for video assets", () => {
    const invalid = {
      ...image,
      kind: "video",
      mimeType: "video/mp4",
    };

    expect(() =>
      MediaAssetSchema.parse(invalid),
    ).toThrow();
  });

  it("rejects invalid content hashes", () => {
    expect(() =>
      MediaAssetSchema.parse({
        ...image,
        sha256: "invalid",
      }),
    ).toThrow();
  });

  it("does not allow unsupported license verification", () => {
    expect(() =>
      MediaAssetSchema.parse({
        ...image,
        provenance: {
          ...image.provenance,
          license: {
            status: "verified",
          },
        },
      }),
    ).toThrow();
  });

  it("accepts a resolved shot", () => {
    const result = MediaResolutionResultSchema.parse({
      status: "resolved",
      shotId: "shot-001",
      asset: image,
      matchScore: 0.92,
    });

    expect(result.status).toBe("resolved");
  });

  it("accepts an explicitly unresolved shot", () => {
    const result = MediaResolutionResultSchema.parse({
      status: "unresolved",
      shotId: "shot-002",
      code: "LOW_RELEVANCE",
      reason: "No suitable footage found",
      retryable: true,
    });

    expect(result.status).toBe("unresolved");
  });

  it("rejects resolved results without an asset", () => {
    expect(() =>
      MediaResolutionResultSchema.parse({
        status: "resolved",
        shotId: "shot-001",
        matchScore: 0.9,
      }),
    ).toThrow();
  });

  it("validates a batch with mixed outcomes", () => {
    const batch = MediaResolutionBatchSchema.parse({
      version: 1,
      jobId: "job-001",
      createdAt: now,
      results: [
        {
          status: "resolved",
          shotId: "shot-001",
          asset: image,
          matchScore: 0.92,
        },
        {
          status: "unresolved",
          shotId: "shot-002",
          code: "NO_MATCH",
          reason: "No usable match",
          retryable: true,
        },
      ],
    });

    expect(batch.results).toHaveLength(2);
  });
});
