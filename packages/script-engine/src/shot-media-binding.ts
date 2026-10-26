import { createHash } from "node:crypto";
import { z } from "zod";

import { MediaAssetSchema } from "@youcreator/contracts";

import {
  MediaResolutionRequestSchema,
  type MediaResolutionRequest,
  type MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  verifyMediaResolutionReport,
} from "./media-report-integrity.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().trim().min(1);

export const ShotMediaBindingSchema = z.object({
  version: z.literal(1),

  shotId: IdSchema,
  shotIndex: z.number().int().nonnegative(),

  mode: z.enum(["A", "B", "C", "D"]),

  asset: MediaAssetSchema,

  source: z.enum([
    "shared_background",
    "local_library",
    "stock",
    "ai_generated",
    "manual_upload",
  ]),

  bindingHash: HashSchema,
}).strict();

export type ShotMediaBinding = z.infer<
  typeof ShotMediaBindingSchema
>;

export const ShotMediaBindingPackageSchema = z.object({
  version: z.literal(1),

  jobId: IdSchema,
  mode: z.enum(["A", "B", "C", "D"]),

  productionPackageHash: HashSchema,
  mediaManifestHash: HashSchema,

  shotCount: z.number().int().positive(),

  bindings: z.array(
    ShotMediaBindingSchema,
  ).min(1),

  bindingPackageHash: HashSchema,
}).strict();

export type ShotMediaBindingPackage = z.infer<
  typeof ShotMediaBindingPackageSchema
>;

export interface CreateShotMediaBindingsInput {
  request: MediaResolutionRequest;
  report: MediaResolutionReport;

  productionPackageHash: string;
  mediaManifestHash: string;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function createShotMediaBindings(
  input: CreateShotMediaBindingsInput,
): ShotMediaBindingPackage {
  const request =
    MediaResolutionRequestSchema.parse(
      input.request,
    );

  const integrity =
    verifyMediaResolutionReport(
      request,
      input.report,
    );

  if (!integrity.complete || !input.report.passed) {
    throw new Error(
      "Cannot bind an incomplete media resolution report",
    );
  }

  const productionPackageHash =
    HashSchema.parse(input.productionPackageHash);

  const mediaManifestHash =
    HashSchema.parse(input.mediaManifestHash);

  const assignments = new Map(
    input.report.assignments.map(
      (assignment) => [
        assignment.shotId,
        assignment,
      ],
    ),
  );

  const bindings = request.shotIds.map(
    (shotId, shotIndex) => {
      const assignment =
        assignments.get(shotId);

      if (!assignment) {
        throw new Error(
          `Missing media assignment: ${shotId}`,
        );
      }

      const identity = {
        version: 1 as const,
        shotId,
        shotIndex,
        mode: request.mode,
        asset: assignment.asset,
        source: assignment.assignmentSource,
      };

      return ShotMediaBindingSchema.parse({
        ...identity,
        bindingHash: hash({
          version: 1,
          productionPackageHash,
          mediaManifestHash,
          shotId,
          shotIndex,
          mode: request.mode,
          assetSha256: assignment.asset.sha256,
          assetId: assignment.asset.id,
          source: assignment.assignmentSource,
          provider: assignment.asset.provenance.source,
          providerAssetId:
            assignment.asset.provenance.providerAssetId ??
            null,
        }),
      });
    },
  );

  const payload = {
    version: 1 as const,
    jobId: request.jobId,
    mode: request.mode,

    productionPackageHash,
    mediaManifestHash,

    shotCount: bindings.length,
    bindings,
  };

  return ShotMediaBindingPackageSchema.parse({
    ...payload,
    bindingPackageHash: hash(payload),
  });
}
