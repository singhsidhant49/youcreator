import {
  PersistentVideoQaStore,
  type VerifiedVideoQaEvidencePort,
} from "./persistent-video-qa.js";

import type {
  VideoQaReleasePolicy,
} from "./video-qa-release-gate.js";

import {
  createNativeVideoQaStage,
} from "./video-qa-stage.js";

export interface NativeVideoQaOptions {
  jobDirectory(jobId: string): string;

  evidence: VerifiedVideoQaEvidencePort;

  policy?: VideoQaReleasePolicy;
}

export function createNativeVideoQaPipeline(
  options: NativeVideoQaOptions,
) {
  const store = new PersistentVideoQaStore({
    jobDirectory: options.jobDirectory,
    evidence: options.evidence,
    policy: options.policy,
  });

  const stage = createNativeVideoQaStage(
    store,
  );

  return {
    store,
    stage,
  };
}

/**
 * This gate is for publication only.
 * It must not be confused with M1 stage success.
 */
export function assertVideoPublishable(
  decision: "PASS" | "REVIEW" | "FAIL",
): void {
  if (decision !== "PASS") {
    throw new Error(
      `M8 video publication blocked: ${decision}`,
    );
  }
}
