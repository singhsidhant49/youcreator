import {
  readFile,
} from "node:fs/promises";

import path from "node:path";
import { z } from "zod";

const HashSchema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

const ModeSchema = z.enum([
  "A",
  "B",
  "C",
  "D",
]);

const ShotSchema = z.object({
  shotId: z.string().trim().min(1),
}).passthrough();

const MediaPlanSchema = z.object({
  mode: ModeSchema,
  shots: z.array(ShotSchema).min(1),
}).passthrough();

const ProductionPackageShapeSchema = z.object({
  storyboard: z.unknown(),
  mediaPlan: MediaPlanSchema,
  packageHash: HashSchema,
}).passthrough();

const EnvelopeShapeSchema = z.object({
  version: z.literal(1),
  jobId: z.string().trim().min(1),
  generationFingerprint:
    z.string().min(1),
  sourceScriptHash: HashSchema,
  package: ProductionPackageShapeSchema,
}).passthrough();

export interface VerifiedM3PackageAdapter<TPackage> {
  /**
   * Must call the authoritative M3 envelope schema.
   * Never replace this with only the structural
   * checks in this module.
   */
  parseEnvelope(input: unknown): {
    version: 1;
    jobId: string;
    package: TPackage;
  };

  /**
   * Must call verifyStoryboardProductionPackage
   * with its actual repository signature.
   * Throw when M3 validation fails.
   */
  verifyPackage(value: TPackage): void | Promise<void>;

  /**
   * Must use the canonical M3 hashing utility.
   * Do not use JSON.stringify directly here.
   */
  hashCanonical(value: unknown): string;

  getMediaPlan(value: TPackage): unknown;

  getStoryboard(value: TPackage): unknown;

  getPackageHash(value: TPackage): string;
}

export interface LoadVerifiedM3Options<TPackage> {
  jobDirectory: string;
  jobId: string;
  expectedMode?: "A" | "B" | "C" | "D";
  adapter: VerifiedM3PackageAdapter<TPackage>;
}

export interface VerifiedProductionPackageResult<TPackage> {
  jobId: string;

  package: TPackage;

  packageHash: string;
  storyboardSha256: string;
  mediaPlanSha256: string;

  mode: "A" | "B" | "C" | "D";
  shotIds: string[];

  artifactPath: string;
}

export async function loadVerifiedProductionPackage<
  TPackage,
>(
  options: LoadVerifiedM3Options<TPackage>,
): Promise<VerifiedProductionPackageResult<TPackage>> {
  if (
    !options.jobId.trim() ||
    !options.jobDirectory.trim()
  ) {
    throw new Error(
      "M3 job ID and job directory are required",
    );
  }

  const artifactPath = path.join(
    path.resolve(options.jobDirectory),
    "storyboard",
    "production-package.json",
  );

  const raw = JSON.parse(
    await readFile(artifactPath, "utf8"),
  ) as unknown;

  // Lightweight shape checks happen first,
  // followed by the authoritative M3 parser.
  const envelopeShape =
    EnvelopeShapeSchema.parse(raw);

  if (
    envelopeShape.jobId !== options.jobId
  ) {
    throw new Error(
      "M3 production package job ID mismatch",
    );
  }

  const envelope =
    options.adapter.parseEnvelope(raw);

  if (envelope.jobId !== options.jobId) {
    throw new Error(
      "Verified M3 envelope job ID mismatch",
    );
  }

  await options.adapter.verifyPackage(
    envelope.package,
  );

  const checkedPackage =
    ProductionPackageShapeSchema.parse(
      envelopeShape.package,
    );

  const mediaPlan = MediaPlanSchema.parse(
    options.adapter.getMediaPlan(
      envelope.package,
    ),
  );

  if (
    options.expectedMode &&
    mediaPlan.mode !== options.expectedMode &&
    !(options.expectedMode === "A" && mediaPlan.mode === "B")
  ) {
    throw new Error(
      "M3 media mode does not match job configuration",
    );
  }

  const shotIds = mediaPlan.shots.map(
    (shot) => shot.shotId,
  );

  if (
    new Set(shotIds).size !== shotIds.length
  ) {
    throw new Error(
      "M3 media plan contains duplicate shot IDs",
    );
  }

  const storyboardSha256 =
    options.adapter.hashCanonical(
      options.adapter.getStoryboard(
        envelope.package,
      ),
    );

  const mediaPlanSha256 =
    options.adapter.hashCanonical(
      options.adapter.getMediaPlan(
        envelope.package,
      ),
    );

  const packageHash =
    options.adapter.getPackageHash(
      envelope.package,
    );

  HashSchema.parse(storyboardSha256);
  HashSchema.parse(mediaPlanSha256);
  HashSchema.parse(packageHash);

  if (
    packageHash !==
    checkedPackage.packageHash
  ) {
    throw new Error(
      "M3 package hash disagreement",
    );
  }

  return {
    jobId: options.jobId,
    package: envelope.package,
    packageHash,
    storyboardSha256,
    mediaPlanSha256,
    mode: mediaPlan.mode,
    shotIds,
    artifactPath,
  };
}
