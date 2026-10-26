import { createHash } from "node:crypto";

import {
  StoryboardArtifactEnvelopeSchema,
} from "./storyboard-job-artifacts.js";

import {
  verifyStoryboardProductionPackage,
  type StoryboardProductionPackage,
} from "./storyboard-production-package.js";

import {
  createM3ProductionAdapter,
} from "./m3-production-adapter.js";

function hashM3Value(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

/**
 * Concrete production adapter.
 *
 * Uses actual M3 envelope parsing and the
 * authoritative package integrity verifier.
 *
 * Unlike the earlier adapter tests, there are
 * no permissive verification callbacks.
 */
export function createAuthoritativeM3Adapter() {
  return createM3ProductionAdapter<
    StoryboardProductionPackage
  >({
    parseEnvelope(input) {
      const envelope =
        StoryboardArtifactEnvelopeSchema.parse(input);

      const verified =
        verifyStoryboardProductionPackage(
          envelope.package,
        );

      if (
        envelope.sourceScriptHash !==
        verified.scriptHash
      ) {
        throw new Error(
          "M3 envelope source script hash mismatch",
        );
      }

      return {
        version: 1,
        jobId: envelope.jobId,
        package: verified,
      };
    },

    verifyPackage(value) {
      verifyStoryboardProductionPackage(value);
    },

    hashCanonical: hashM3Value,

    getStoryboard(value) {
      return value.storyboard;
    },

    getMediaPlan(value) {
      return value.mediaPlan;
    },

    getPackageHash(value) {
      return value.packageHash;
    },
  });
}
