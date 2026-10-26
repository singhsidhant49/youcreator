import { z } from "zod";

import {
  MediaAssetSchema,
} from "@youcreator/contracts";

const ShotIdSchema = z.string().min(1);

export const AssignedMediaSchema = z.object({
  version: z.literal(1),
  shotId: ShotIdSchema,

  mode: z.enum(["A", "B", "C", "D"]),

  asset: MediaAssetSchema,

  assignmentSource: z.enum([
    "shared_background",
    "local_library",
    "stock",
    "ai_generated",
    "manual_upload",
  ]),

  assignedAt: z.string().datetime(),
}).strict();

export type AssignedMedia = z.infer<
  typeof AssignedMediaSchema
>;

export const MediaAssignmentOutcomeSchema =
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("assigned"),
      assignment: AssignedMediaSchema,
    }).strict(),

    z.object({
      status: z.literal("unresolved"),
      shotId: ShotIdSchema,
      reason: z.enum([
        "MISSING_ASSET",
        "INVALID_ASSET",
        "MODE_MISMATCH",
        "REVIEW_REQUIRED",
      ]),
      message: z.string().min(1),
    }).strict(),
  ]);

export type MediaAssignmentOutcome = z.infer<
  typeof MediaAssignmentOutcomeSchema
>;
