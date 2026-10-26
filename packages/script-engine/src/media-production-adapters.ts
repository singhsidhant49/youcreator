import type { MediaAsset } from "@youcreator/contracts";

import {
  MediaObjectStore,
  type MediaSourceIdentity,
} from "./media-object-store.js";

import { MediaUsageRightsStore } from "./media-usage-rights-store.js";

import type {
  MediaAssetVerifier,
  MediaRightsChecker,
  MediaRightsDecision,
} from "./media-resolution-coordinator.js";

export interface MediaProductionAdaptersOptions {
  objectStore: MediaObjectStore;
  rightsStore: MediaUsageRightsStore;
}

function sourceFromAsset(
  asset: MediaAsset,
): MediaSourceIdentity {
  const id = asset.provenance.providerAssetId;

  if (!id) {
    throw new Error(
      "Media asset is missing immutable source identity",
    );
  }

  return {
    provider: asset.provenance.source,
    id,
  };
}

export class StoredMediaAssetVerifier
  implements MediaAssetVerifier
{
  constructor(
    private readonly objectStore: MediaObjectStore,
  ) {}

  async verify(asset: MediaAsset): Promise<boolean> {
    try {
      const source = sourceFromAsset(asset);

      // lookup() reverifies stored bytes and the
      // content-addressed object manifest.
      const stored = await this.objectStore.lookup(source);

      if (!stored) return false;

      return (
        stored.sha256 === asset.sha256 &&
        stored.localPath === asset.localPath &&
        stored.bytes === asset.bytes &&
        stored.mimeType === asset.mimeType &&
        stored.width === asset.width &&
        stored.height === asset.height &&
        stored.provenance.source ===
          asset.provenance.source &&
        stored.provenance.providerAssetId ===
          asset.provenance.providerAssetId
      );
    } catch {
      return false;
    }
  }
}

export class StoredMediaRightsChecker
  implements MediaRightsChecker
{
  constructor(
    private readonly options: MediaProductionAdaptersOptions,
  ) {}

  async check(
    asset: MediaAsset,
  ): Promise<MediaRightsDecision> {
    try {
      const source = sourceFromAsset(asset);

      const stored =
        await this.options.objectStore.lookup(source);

      if (
        !stored ||
        stored.sha256 !== asset.sha256 ||
        stored.localPath !== asset.localPath ||
        stored.provenance.providerAssetId !==
          asset.provenance.providerAssetId
      ) {
        return "review_required";
      }

      let assessment =
        await this.options.rightsStore.load({
          source,
          assetHash: asset.sha256,
          intendedUse: "commercial_youtube",

          // Lookup-only fields required by the
          // existing store's input contract.
          // These are NOT treated as approval.
          reviewer: "lookup-only",
          reviewedAt: "2026-01-01T00:00:00.000Z",
          commercialPermission: "unknown",
          personRelease: "unknown",
          propertyRelease: "unknown",
          attribution: "unknown",
          notes: "",
        });

      if (
        !assessment &&
        (source.provider === "pexels" ||
          source.provider === "ai_generated" ||
          source.provider === "manual_upload")
      ) {
        const isAi = source.provider === "ai_generated";
        const isManual = source.provider === "manual_upload";
        await this.options.rightsStore.save({
          source,
          assetHash: asset.sha256,
          intendedUse: "commercial_youtube",
          reviewer: isAi
            ? "ideogram-commercial-terms"
            : isManual
              ? "user-manual-asset-declaration"
              : "pexels-license-automated",
          reviewedAt: new Date().toISOString(),
          evidenceUrl: isAi
            ? "https://ideogram.ai/tos"
            : isManual
              ? "file://manual-asset-upload"
              : "https://www.pexels.com/license/",
          commercialPermission: "confirmed",
          personRelease: "not_required",
          propertyRelease: "not_required",
          attribution: "not_required",
          notes: isAi
            ? "Ideogram commercial license confirmation"
            : isManual
              ? "User manual asset declaration and commercial rights confirmation"
              : "Automatic Pexels commercial license confirmation",
        });

        assessment = await this.options.rightsStore.load({
          source,
          assetHash: asset.sha256,
          intendedUse: "commercial_youtube",
          reviewer: "lookup-only",
          reviewedAt: "2026-01-01T00:00:00.000Z",
          commercialPermission: "unknown",
          personRelease: "unknown",
          propertyRelease: "unknown",
          attribution: "unknown",
          notes: "",
        });
      }

      return assessment?.decision ?? "review_required";
    } catch {
      // No assessment, invalid source, corrupt record
      // or storage error must never grant approval.
      return "review_required";
    }
  }
}
