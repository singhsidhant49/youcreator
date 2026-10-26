import { z } from "zod";

import {
  MediaSourceSchema,
  type MediaAsset,
} from "@youcreator/contracts";

const Sha256Schema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

const PermissionSchema = z.enum([
  "confirmed",
  "unknown",
  "denied",
]);

const ClearanceSchema = z.enum([
  "confirmed",
  "not_required",
  "unknown",
  "denied",
]);

export const MediaUsageRightsInputSchema = z.object({
  source: z.object({
    provider: MediaSourceSchema,
    id: z.string().trim().min(1).max(512),
  }).strict(),

  assetHash: Sha256Schema,

  intendedUse: z.literal(
    "commercial_youtube",
  ),

  // Human or accountable external assessment.
  reviewer: z.string().trim().min(1),
  reviewedAt: z.string().datetime(),

  // Evidence supporting the license decision.
  evidenceUrl: z.string().url().optional(),

  commercialPermission: PermissionSchema,

  // Confirmed or not required must be backed by
  // the reviewer's evidence, not inferred from metadata.
  personRelease: ClearanceSchema,
  propertyRelease: ClearanceSchema,

  attribution: z.enum([
    "satisfied",
    "not_required",
    "unknown",
    "unsatisfied",
  ]),

  notes: z.string().max(4000).default(""),
}).strict();

export const MediaUsageDecisionSchema = z.enum([
  "approved",
  "review_required",
  "rejected",
]);

export const MediaUsageIssueSchema = z.enum([
  "LICENSE_EVIDENCE_MISSING",
  "COMMERCIAL_PERMISSION_UNKNOWN",
  "COMMERCIAL_PERMISSION_DENIED",
  "PERSON_RELEASE_UNKNOWN",
  "PERSON_RELEASE_DENIED",
  "PROPERTY_RELEASE_UNKNOWN",
  "PROPERTY_RELEASE_DENIED",
  "ATTRIBUTION_UNKNOWN",
  "ATTRIBUTION_UNSATISFIED",
]);

export const MediaUsageAssessmentSchema = z.object({
  version: z.literal(1),
  input: MediaUsageRightsInputSchema,
  decision: MediaUsageDecisionSchema,
  issues: z.array(MediaUsageIssueSchema),
}).strict();

export type MediaUsageRightsInput = z.input<
  typeof MediaUsageRightsInputSchema
>;

export type MediaUsageAssessment = z.infer<
  typeof MediaUsageAssessmentSchema
>;

export function evaluateMediaUsageRights(
  input: MediaUsageRightsInput,
): MediaUsageAssessment {
  const checked =
    MediaUsageRightsInputSchema.parse(input);

  const issues: z.infer<
    typeof MediaUsageIssueSchema
  >[] = [];

  if (!checked.evidenceUrl) {
    issues.push("LICENSE_EVIDENCE_MISSING");
  }

  if (checked.commercialPermission === "unknown") {
    issues.push("COMMERCIAL_PERMISSION_UNKNOWN");
  } else if (
    checked.commercialPermission === "denied"
  ) {
    issues.push("COMMERCIAL_PERMISSION_DENIED");
  }

  if (checked.personRelease === "unknown") {
    issues.push("PERSON_RELEASE_UNKNOWN");
  } else if (checked.personRelease === "denied") {
    issues.push("PERSON_RELEASE_DENIED");
  }

  if (checked.propertyRelease === "unknown") {
    issues.push("PROPERTY_RELEASE_UNKNOWN");
  } else if (checked.propertyRelease === "denied") {
    issues.push("PROPERTY_RELEASE_DENIED");
  }

  if (checked.attribution === "unknown") {
    issues.push("ATTRIBUTION_UNKNOWN");
  } else if (
    checked.attribution === "unsatisfied"
  ) {
    issues.push("ATTRIBUTION_UNSATISFIED");
  }

  const rejected = issues.some((issue) =>
    issue.endsWith("_DENIED") ||
    issue === "ATTRIBUTION_UNSATISFIED",
  );

  const decision = rejected
    ? "rejected"
    : issues.length > 0
      ? "review_required"
      : "approved";

  return MediaUsageAssessmentSchema.parse({
    version: 1,
    input: checked,
    decision,
    issues,
  });
}

/**
 * Binds an assessment to the exact source and
 * content addressed by a MediaAsset.
 */
export function assertUsageAssessmentMatchesAsset(
  assessment: MediaUsageAssessment,
  asset: MediaAsset,
): void {
  if (
    assessment.input.assetHash !== asset.sha256 ||
    assessment.input.source.provider !==
      asset.provenance.source
  ) {
    throw new Error(
      "Media usage assessment does not match asset",
    );
  }
}
