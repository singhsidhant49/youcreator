import { z } from "zod";

import type {
  VideoBatchResult,
  VideoBatchSpec,
} from "./video-batch-contract.js";

export const BatchRetryRequestSchema = z.object({
  jobIds: z.array(z.string().min(1))
    .min(1)
    .max(1000),
  maxAttemptsPerJob: z.number()
    .int()
    .min(1)
    .max(20),
}).strict();

export interface RetrySelection {
  selected: string[];
  rejected: Array<{
    jobId: string;
    reason:
      | "UNKNOWN_JOB"
      | "NOT_FAILED"
      | "ATTEMPTS_EXHAUSTED";
  }>;
}

export function selectFailedJobsForRetry(
  spec: VideoBatchSpec,
  results: readonly VideoBatchResult[],
  request: z.input<
    typeof BatchRetryRequestSchema
  >,
): RetrySelection {
  const policy =
    BatchRetryRequestSchema.parse(request);

  if (
    new Set(policy.jobIds).size !==
    policy.jobIds.length
  ) {
    throw new Error(
      "M9 duplicate retry job IDs",
    );
  }

  const knownJobs = new Set(
    spec.jobs.map((job) => job.jobId),
  );

  const byId = new Map(
    results.map((result) => [
      result.jobId,
      result,
    ]),
  );

  const selected: string[] = [];
  const rejected: RetrySelection["rejected"] = [];

  for (const jobId of policy.jobIds) {
    const result = byId.get(jobId);

    if (!knownJobs.has(jobId) || !result) {
      rejected.push({
        jobId,
        reason: "UNKNOWN_JOB",
      });
      continue;
    }

    if (result.state !== "FAILED") {
      rejected.push({
        jobId,
        reason: "NOT_FAILED",
      });
      continue;
    }

    if (
      result.attempt >=
      policy.maxAttemptsPerJob
    ) {
      rejected.push({
        jobId,
        reason: "ATTEMPTS_EXHAUSTED",
      });
      continue;
    }

    selected.push(jobId);
  }

  return { selected, rejected };
}
