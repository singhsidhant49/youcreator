import { z } from "zod";

import type {
  VerifiedM3PackageAdapter,
} from "./verified-production-package.js";

const HashSchema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

const ModeSchema = z.enum([
  "A",
  "B",
  "C",
  "D",
]);

const PackageShapeSchema = z.object({
  storyboard: z.unknown(),
  mediaPlan: z.object({
    mode: ModeSchema,
    shots: z.array(
      z.object({
        shotId: z.string().trim().min(1),
      }).passthrough(),
    ).min(1),
  }).passthrough(),
  packageHash: HashSchema,
}).passthrough();

const EnvelopeShapeSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  package: PackageShapeSchema,
}).passthrough();

export interface M3ProductionAdapterDependencies<
  TPackage,
> {
  /**
   * Supply StoryboardArtifactEnvelopeSchema.parse
   * from the actual M3 implementation.
   */
  parseEnvelope(input: unknown): {
    version: 1;
    jobId: string;
    package: TPackage;
  };

  /**
   * Supply a function that calls the real
   * verifyStoryboardProductionPackage().
   *
   * It MUST throw on failure.
   */
  verifyPackage(
    value: TPackage,
  ): void | Promise<void>;

  /**
   * Supply the canonical M3 hash utility.
   * Do not replace it with plain JSON.stringify.
   */
  hashCanonical(value: unknown): string;

  getStoryboard(value: TPackage): unknown;

  getMediaPlan(value: TPackage): unknown;

  getPackageHash(value: TPackage): string;
}

export function createM3ProductionAdapter<
  TPackage,
>(
  dependencies:
    M3ProductionAdapterDependencies<TPackage>,
): VerifiedM3PackageAdapter<TPackage> {
  if (
    !dependencies.parseEnvelope ||
    !dependencies.verifyPackage ||
    !dependencies.hashCanonical
  ) {
    throw new Error(
      "Authoritative M3 parser, verifier and hash function are required",
    );
  }

  return {
    parseEnvelope(input: unknown) {
      const shape =
        EnvelopeShapeSchema.parse(input);

      const envelope =
        dependencies.parseEnvelope(input);

      if (
        envelope.jobId !== shape.jobId ||
        envelope.version !== shape.version
      ) {
        throw new Error(
          "Authoritative M3 envelope identity mismatch",
        );
      }

      return envelope;
    },

    async verifyPackage(value: TPackage) {
      PackageShapeSchema.parse(value);

      // Only the actual M3 verifier is allowed
      // to establish canonical package validity.
      await dependencies.verifyPackage(value);

      const plan =
        dependencies.getMediaPlan(value);

      const checkedPlan =
        PackageShapeSchema.shape.mediaPlan.parse(
          plan,
        );

      const shotIds =
        checkedPlan.shots.map(
          (shot) => shot.shotId,
        );

      if (
        new Set(shotIds).size !==
        shotIds.length
      ) {
        throw new Error(
          "Verified M3 package contains duplicate shot IDs",
        );
      }

      const hash =
        dependencies.getPackageHash(value);

      HashSchema.parse(hash);
    },

    hashCanonical(value: unknown) {
      const hash =
        dependencies.hashCanonical(value);

      return HashSchema.parse(hash);
    },

    getStoryboard(value: TPackage) {
      return dependencies.getStoryboard(value);
    },

    getMediaPlan(value: TPackage) {
      return dependencies.getMediaPlan(value);
    },

    getPackageHash(value: TPackage) {
      return HashSchema.parse(
        dependencies.getPackageHash(value),
      );
    },
  };
}
