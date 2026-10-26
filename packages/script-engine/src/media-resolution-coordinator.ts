import { z } from "zod";

import type {
  MediaAsset,
} from "@youcreator/contracts";

import {
  AssignedMediaSchema,
  MediaAssignmentOutcomeSchema,
  type AssignedMedia,
  type MediaAssignmentOutcome,
} from "./assigned-media.js";

import type {
  ManualSharedMediaService,
} from "./manual-shared-media.js";

import {
  StockVisualPolicySchema,
} from "./stock-visual-policy.js";

const IdSchema = z.string().trim().min(1);

const ShotIdsSchema = z.array(IdSchema)
  .min(1)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Expected shot IDs must be unique",
  );

const BaseSchema = z.object({
  jobId: IdSchema,
  shotIds: ShotIdsSchema,
});

const LegacyMediaResolutionRequestSchema = z.discriminatedUnion("mode", [
  BaseSchema.extend({
    version: z.literal(1).optional(),
    mode: z.literal("A"),
    backgroundId: IdSchema,
    localPath: z.string().min(1),
  }).strict(),

  BaseSchema.extend({
    version: z.literal(1).optional(),
    mode: z.literal("B"),
  }).strict(),

  BaseSchema.extend({
    version: z.literal(1).optional(),
    mode: z.literal("C"),
    allowPaidGeneration: z.boolean(),
  }).strict(),

  BaseSchema.extend({
    version: z.literal(1).optional(),
    mode: z.literal("D"),
    assignments: z.array(
      z.object({
        shotId: IdSchema,
        assetId: IdSchema,
        localPath: z.string().min(1),
      }).strict(),
    ),
  }).strict(),
]);

const Version2MediaResolutionRequestSchema = z.discriminatedUnion("mode", [
  BaseSchema.extend({
    version: z.literal(2),
    mode: z.literal("A"), // Canonical Mode A: Intelligent Stock & Web
    policy: StockVisualPolicySchema.optional(),
  }).strict(),

  BaseSchema.extend({
    version: z.literal(2),
    mode: z.literal("B"), // Canonical Mode B: AI-Generated Visuals
    allowPaidGeneration: z.boolean().default(true),
    provider: z.string().optional(),
    model: z.string().optional(),
  }).strict(),

  BaseSchema.extend({
    version: z.literal(2),
    mode: z.literal("C"), // Canonical Mode C: Manual Visuals
    assignments: z.array(
      z.object({
        shotId: IdSchema,
        assetId: IdSchema,
        localPath: z.string().min(1),
      }).strict(),
    ),
  }).strict(),
]);

export const MediaResolutionRequestSchema = z.union([
  Version2MediaResolutionRequestSchema,
  LegacyMediaResolutionRequestSchema,
]);

export type MediaResolutionRequest = z.input<
  typeof MediaResolutionRequestSchema
>;

export interface ShotMediaResolver {
  resolve(shotId: string): Promise<MediaAssignmentOutcome>;
}

export interface MediaAssetVerifier {
  verify(asset: MediaAsset): Promise<boolean>;
}

export type MediaRightsDecision =
  | "approved"
  | "review_required"
  | "rejected";

export interface MediaRightsChecker {
  check(asset: MediaAsset): Promise<MediaRightsDecision>;
}

export type MediaQAIssueCode =
  | "MISSING_SHOT"
  | "DUPLICATE_SHOT"
  | "UNKNOWN_SHOT"
  | "MODE_MISMATCH"
  | "ASSIGNMENT_INVALID"
  | "ASSET_VERIFICATION_FAILED"
  | "RIGHTS_NOT_APPROVED"
  | "RESOLUTION_FAILED"
  | "REPEATED_ASSET";

export interface MediaQAIssue {
  code: MediaQAIssueCode;
  severity: "blocker" | "warning";
  shotId?: string;
  message: string;
}

export interface MediaResolutionReport {
  version: 1;
  jobId: string;
  mode: "A" | "B" | "C" | "D";

  expectedShots: number;
  assignedShots: number;

  outcomes: MediaAssignmentOutcome[];
  assignments: AssignedMedia[];

  issues: MediaQAIssue[];

  passed: boolean;
}

export interface MediaResolutionCoordinatorOptions {
  manualShared: Pick<
    ManualSharedMediaService,
    "assignSharedBackground" | "assignManualMedia"
  >;

  stockResolver?: ShotMediaResolver;
  aiResolver?: ShotMediaResolver;

  // Must reverify stored bytes, not just metadata.
  assetVerifier: MediaAssetVerifier;

  // Must use a trusted rights assessment.
  rightsChecker: MediaRightsChecker;
}

function failure(
  shotId: string,
  message: string,
): MediaAssignmentOutcome {
  return {
    status: "unresolved",
    shotId,
    reason: "INVALID_ASSET",
    message,
  };
}

export class MediaResolutionCoordinator {
  constructor(
    private readonly options:
      MediaResolutionCoordinatorOptions,
  ) {}

  private async resolveOne(
    resolver: ShotMediaResolver | undefined,
    shotId: string,
  ): Promise<MediaAssignmentOutcome> {
    if (!resolver) {
      return failure(
        shotId,
        "No resolver configured for this mode",
      );
    }

    try {
      return MediaAssignmentOutcomeSchema.parse(
        await resolver.resolve(shotId),
      );
    } catch (error) {
      return failure(
        shotId,
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  }

  async run(
    input: MediaResolutionRequest,
  ): Promise<MediaResolutionReport> {
    const request =
      MediaResolutionRequestSchema.parse(input);

    const isV2 = "version" in request && request.version === 2;
    let raw: MediaAssignmentOutcome[];

    if (isV2) {
      switch (request.mode) {
        case "A": {
          // Canonical Mode A: Intelligent Stock & Web Resolver
          // Strict Mode A: Never call AI image-generation APIs!
          raw = [];
          for (const shotId of request.shotIds) {
            raw.push(
              await this.resolveOne(
                this.options.stockResolver,
                shotId,
              ),
            );
          }
          break;
        }

        case "B": {
          // Canonical Mode B: AI-Generated Visuals Resolver
          // Strict Mode B: Never fall back to stock providers!
          raw = [];
          for (const shotId of request.shotIds) {
            raw.push(
              request.allowPaidGeneration
                ? await this.resolveOne(
                    this.options.aiResolver,
                    shotId,
                  )
                : failure(
                    shotId,
                    "Paid AI generation is not authorized",
                  ),
            );
          }
          break;
        }

        case "C": {
          // Canonical Mode C: Manual Visuals Resolver
          // Strict Mode C: Uses user manual assignments only, no stock or AI retrieval.
          raw = await this.options.manualShared.assignManualMedia({
            mode: "C",
            assignments: request.assignments,
          });
          break;
        }
      }
    } else {
      // Legacy Version 1 routing
      switch (request.mode) {
        case "A":
          raw =
            await this.options.manualShared
              .assignSharedBackground({
                mode: "A",
                backgroundId:
                  request.backgroundId,
                localPath: request.localPath,
                shotIds: request.shotIds,
              });
          break;

        case "D":
          raw =
            await this.options.manualShared
              .assignManualMedia({
                mode: "D",
                assignments: request.assignments,
              });
          break;

        case "B":
          raw = [];
          for (const shotId of request.shotIds) {
            raw.push(
              await this.resolveOne(
                this.options.stockResolver,
                shotId,
              ),
            );
          }
          break;

        case "C":
          raw = [];
          for (const shotId of request.shotIds) {
            raw.push(
              request.allowPaidGeneration
                ? await this.resolveOne(
                    this.options.aiResolver,
                    shotId,
                  )
                : failure(
                    shotId,
                    "Paid AI generation is not authorized",
                  ),
            );
          }
          break;
      }
    }

    const outcomes: MediaAssignmentOutcome[] = [];
    const assignments: AssignedMedia[] = [];
    const issues: MediaQAIssue[] = [];

    const expected = new Set(request.shotIds);
    const seen = new Set<string>();
    const usedHashes = new Set<string>();

    for (let item of raw) {
      // Normalize assignment mode for Version 2 canonical modes
      if (
        isV2 &&
        item.status === "assigned" &&
        item.assignment.mode !== request.mode
      ) {
        item = {
          ...item,
          assignment: {
            ...item.assignment,
            mode: request.mode,
          },
        };
      }

      const outcome =
        MediaAssignmentOutcomeSchema.parse(item);

      const shotId = outcome.status === "assigned"
        ? outcome.assignment.shotId
        : outcome.shotId;

      if (!expected.has(shotId)) {
        issues.push({
          code: "UNKNOWN_SHOT",
          severity: "blocker",
          shotId,
          message:
            "Resolver returned a shot not present in the request",
        });
        continue;
      }

      if (seen.has(shotId)) {
        issues.push({
          code: "DUPLICATE_SHOT",
          severity: "blocker",
          shotId,
          message:
            "Multiple outcomes for the same shot",
        });
        continue;
      }

      seen.add(shotId);
      outcomes.push(outcome);

      if (outcome.status === "unresolved") {
        issues.push({
          code: "RESOLUTION_FAILED",
          severity: "blocker",
          shotId,
          message: outcome.message,
        });
        continue;
      }

      const assignment = AssignedMediaSchema.parse(
        outcome.assignment,
      );

      if (assignment.mode !== request.mode) {
        issues.push({
          code: "MODE_MISMATCH",
          severity: "blocker",
          shotId,
          message:
            "Assignment mode does not match job mode",
        });
        continue;
      }

      let verified = false;

      try {
        verified =
          await this.options.assetVerifier.verify(
            assignment.asset,
          );
      } catch {
        verified = false;
      }

      if (!verified) {
        issues.push({
          code: "ASSET_VERIFICATION_FAILED",
          severity: "blocker",
          shotId,
          message:
            "Stored media failed verification",
        });
        continue;
      }

      let rights: MediaRightsDecision =
        "review_required";

      try {
        rights =
          await this.options.rightsChecker.check(
            assignment.asset,
          );
      } catch {
        // A failed rights check never grants approval.
      }

      if (rights !== "approved") {
        issues.push({
          code: "RIGHTS_NOT_APPROVED",
          severity: "blocker",
          shotId,
          message:
            `Media usage rights: ${rights}`,
        });
        continue;
      }

      // Check repeated assets:
      // In legacy Mode A (shared background), repeated asset across shots is expected.
      // In Version 2 Mode A (Intelligent Stock), repeated assets should trigger warning.
      const isLegacySharedBackground = !isV2 && request.mode === "A";

      if (
        !isLegacySharedBackground &&
        usedHashes.has(assignment.asset.sha256)
      ) {
        issues.push({
          code: "REPEATED_ASSET",
          severity: "warning",
          shotId,
          message:
            "Media bytes are repeated across shots",
        });
      }

      usedHashes.add(
        assignment.asset.sha256,
      );

      assignments.push(assignment);
    }

    for (const shotId of request.shotIds) {
      if (!seen.has(shotId)) {
        issues.push({
          code: "MISSING_SHOT",
          severity: "blocker",
          shotId,
          message:
            "Expected shot was not resolved",
        });
      }
    }

    const hasBlockers = issues.some(
      (issue) => issue.severity === "blocker",
    );

    return {
      version: 1,
      jobId: request.jobId,
      mode: request.mode,
      expectedShots: request.shotIds.length,
      assignedShots: assignments.length,
      outcomes,
      assignments,
      issues,
      passed:
        !hasBlockers &&
        assignments.length === request.shotIds.length,
    };
  }
}

export function resolveModeCAssignments(
  rawAssignments: readonly any[] | undefined,
  shotIds: readonly string[],
): { shotId: string; assetId: string; localPath: string }[] {
  const raw = Array.isArray(rawAssignments) ? rawAssignments : [];
  if (raw.length === 0) return [];
  return shotIds.map((shotId, idx) => {
    const exact = raw.find((a: any) => a.shotId === shotId);
    if (exact && exact.localPath) {
      return {
        shotId,
        assetId: exact.assetId ?? `manual-asset-${idx + 1}`,
        localPath: exact.localPath,
      };
    }
    const source = raw[idx % raw.length];
    return {
      shotId,
      assetId: source.assetId ?? `manual-asset-${idx + 1}`,
      localPath: source.localPath,
    };
  });
}

