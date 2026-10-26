import {
  describe,
  expect,
  it,
} from "vitest";

import {
  selectFailedJobsForRetry,
} from "./video-batch-recovery.js";

import type {
  VideoBatchSpec,
  VideoBatchResult,
} from "./video-batch-contract.js";

const spec: VideoBatchSpec = {
  version: 1,
  batchId: "recovery",
  jobs: [
    {
      jobId: "a",
      topic: "Topic A",
      profileId: "explainer",
    },
    {
      jobId: "b",
      topic: "Topic B",
      profileId: "story",
    },
  ],
};

const results: VideoBatchResult[] = [
  {
    jobId: "a",
    state: "FAILED",
    attempt: 1,
    exportHash: null,
    errorCode: "VIDEO_JOB_FAILED",
  },
  {
    jobId: "b",
    state: "SUCCEEDED",
    attempt: 1,
    exportHash: "a".repeat(64),
    errorCode: null,
  },
];

describe("M9.6 batch recovery policy", () => {
  it("selects only explicitly failed jobs", () => {
    const selected = selectFailedJobsForRetry(
      spec,
      results,
      {
        jobIds: ["a"],
        maxAttemptsPerJob: 3,
      },
    );

    expect(selected.selected).toEqual(["a"]);
    expect(selected.rejected).toEqual([]);
  });

  it("never retries successful jobs", () => {
    const selected = selectFailedJobsForRetry(
      spec,
      results,
      {
        jobIds: ["b"],
        maxAttemptsPerJob: 3,
      },
    );

    expect(selected.selected).toEqual([]);
    expect(selected.rejected[0]?.reason)
      .toBe("NOT_FAILED");
  });

  it("enforces retry attempt limits", () => {
    const selected = selectFailedJobsForRetry(
      spec,
      results,
      {
        jobIds: ["a"],
        maxAttemptsPerJob: 1,
      },
    );

    expect(selected.selected).toEqual([]);
    expect(selected.rejected[0]?.reason)
      .toBe("ATTEMPTS_EXHAUSTED");
  });

  it("rejects unknown jobs", () => {
    const selected = selectFailedJobsForRetry(
      spec,
      results,
      {
        jobIds: ["missing"],
        maxAttemptsPerJob: 3,
      },
    );

    expect(selected.rejected[0]?.reason)
      .toBe("UNKNOWN_JOB");
  });
});
