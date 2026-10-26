import { z } from "zod";

import {
  type MediaAsset,
} from "@youcreator/contracts";

import {
  MediaAcquirer,
} from "./media-acquirer.js";

import {
  MediaObjectStore,
  type MediaSourceIdentity,
} from "./media-object-store.js";

import {
  AssignedMediaSchema,
  MediaAssignmentOutcomeSchema,
  type AssignedMedia,
  type MediaAssignmentOutcome,
} from "./assigned-media.js";

const ShotIdSchema = z.string().min(1);

const SharedBackgroundRequestSchema = z.object({
  mode: z.literal("A"),
  backgroundId: z.string().trim().min(1),
  localPath: z.string().min(1),
  shotIds: z.array(ShotIdSchema)
    .min(1)
    .refine(
      (items) => new Set(items).size === items.length,
      "Shot IDs must be unique",
    ),
}).strict();

const ManualMediaRequestSchema = z.object({
  mode: z.enum(["C", "D"]),
  assignments: z.array(
    z.object({
      shotId: ShotIdSchema,
      assetId: z.string().trim().min(1),
      localPath: z.string().min(1),
    }).strict(),
  ).min(1).refine(
    (items) =>
      new Set(items.map(
        (item) => item.shotId,
      )).size === items.length,
    "Manual assignments require unique shot IDs",
  ),
}).strict();

export type SharedBackgroundRequest = z.infer<
  typeof SharedBackgroundRequestSchema
>;

export type ManualMediaRequest = z.infer<
  typeof ManualMediaRequestSchema
>;

export interface ManualSharedMediaServiceOptions {
  acquirer: MediaAcquirer;
  objectStore: MediaObjectStore;
}

function createAssignment(
  shotId: string,
  mode: "A" | "C" | "D",
  asset: MediaAsset,
): AssignedMedia {
  return AssignedMediaSchema.parse({
    version: 1,
    shotId,
    mode,
    asset,
    assignmentSource:
      mode === "A"
        ? "shared_background"
        : "manual_upload",
    assignedAt: new Date().toISOString(),
  });
}

function unresolved(
  shotId: string,
  reason:
    | "MISSING_ASSET"
    | "INVALID_ASSET"
    | "MODE_MISMATCH"
    | "REVIEW_REQUIRED",
  message: string,
): MediaAssignmentOutcome {
  return MediaAssignmentOutcomeSchema.parse({
    status: "unresolved",
    shotId,
    reason,
    message,
  });
}

export class ManualSharedMediaService {
  constructor(
    private readonly options:
      ManualSharedMediaServiceOptions,
  ) {}

  private async acquireAndRegister(
    source: MediaSourceIdentity,
    localPath: string,
  ): Promise<MediaAsset> {
    const existing = await this.options.objectStore.lookup(
      source,
    );

    if (existing) {
      try {
        const { readFile } = await import("node:fs/promises");
        const { createHash } = await import("node:crypto");
        const currentBytes = await readFile(localPath);
        const currentHash = createHash("sha256").update(currentBytes).digest("hex");
        if (existing.sha256 === currentHash) {
          return existing;
        }
      } catch {
        // Fall through to re-acquire if verification fails
      }
    }

    const acquired =
      await this.options.acquirer.acquire({
        id: source.id,
        provider: "local_library",
        kind: "image",
        description:
          "User supplied local media asset",
        localPath,
        keywords: [],
      });

    // The acquirer uses local_library as its source
    // because the bytes are read from an approved root.
    // For Mode A/D, we must record the logical source
    // in the returned asset before registration.
    const asset = {
      ...acquired,
      provenance: {
        ...acquired.provenance,
        source: source.provider,
        providerAssetId: source.id,
      },
    } as MediaAsset;

    return this.options.objectStore.register(
      source,
      asset,
    );
  }

  async assignSharedBackground(
    input: SharedBackgroundRequest,
  ): Promise<MediaAssignmentOutcome[]> {
    const request =
      SharedBackgroundRequestSchema.parse(input);

    const source: MediaSourceIdentity = {
      provider: "shared_background",
      id: request.backgroundId,
    };

    let asset: MediaAsset;

    try {
      asset = await this.acquireAndRegister(
        source,
        request.localPath,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return request.shotIds.map(
        (shotId) =>
          unresolved(
            shotId,
            "INVALID_ASSET",
            message,
          ),
      );
    }

    return request.shotIds.map(
      (shotId) =>
        MediaAssignmentOutcomeSchema.parse({
          status: "assigned",
          assignment: createAssignment(
            shotId,
            "A",
            asset,
          ),
        }),
    );
  }

  async assignManualMedia(
    input: ManualMediaRequest,
  ): Promise<MediaAssignmentOutcome[]> {
    const request =
      ManualMediaRequestSchema.parse(input);

    const results: MediaAssignmentOutcome[] = [];

    for (const item of request.assignments) {
      const source: MediaSourceIdentity = {
        provider: "manual_upload",
        id: item.assetId,
      };

      try {
        const asset =
          await this.acquireAndRegister(
            source,
            item.localPath,
          );

        results.push(
          MediaAssignmentOutcomeSchema.parse({
            status: "assigned",
            assignment: createAssignment(
              item.shotId,
              request.mode,
              asset,
            ),
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        results.push(
          unresolved(
            item.shotId,
            "INVALID_ASSET",
            message,
          ),
        );
      }
    }

    return results;
  }
}
