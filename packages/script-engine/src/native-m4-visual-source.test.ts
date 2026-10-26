import {
  describe,
  expect,
  it,
} from "vitest";

import {
  assertNativeM4ManifestPreflight,
} from "./native-m4-visual-source.js";

const JOB_ID = "job-m5-native-m4";
const STORYBOARD_HASH = "a".repeat(64);
const MEDIA_PLAN_HASH = "b".repeat(64);

const SHOTS = [
  "shot-001",
  "shot-002",
];

function manifest() {
  return {
    version: 1,
    inputHash: "c".repeat(64),

    jobId: JOB_ID,

    storyboardSha256:
      STORYBOARD_HASH,

    mediaPlanSha256:
      MEDIA_PLAN_HASH,

    stageVersion: "m4-resolution-v1",

    completedAt:
      "2026-10-13T10:00:00.000Z",

    report: {
      version: 1,
      jobId: JOB_ID,
      mode: "B",
      expectedShots: 2,
      assignedShots: 2,

      assignments: [
        { shotId: "shot-001" },
        { shotId: "shot-002" },
      ],

      outcomes: [],
      issues: [],
      passed: true,
    },
  };
}

function verify(
  savedManifest: unknown,
  overrides: Partial<{
    jobId: string;
    storyboardSha256: string;
    mediaPlanSha256: string;
    shotIds: string[];
  }> = {},
) {
  assertNativeM4ManifestPreflight({
    manifest: savedManifest,
    jobId: JOB_ID,
    storyboardSha256:
      STORYBOARD_HASH,
    mediaPlanSha256:
      MEDIA_PLAN_HASH,
    shotIds: SHOTS,
    ...overrides,
  });
}

describe("Native M4 manifest preflight", () => {
  it("accepts matching completed manifest identity", () => {
    expect(() =>
      verify(manifest()),
    ).not.toThrow();
  });

  it("rejects mismatched M3 digests", () => {
    const saved = manifest();

    saved.storyboardSha256 =
      "d".repeat(64);

    expect(() =>
      verify(saved),
    ).toThrow(
      "Native M4 manifest identity mismatch",
    );

    saved.storyboardSha256 =
      STORYBOARD_HASH;

    saved.mediaPlanSha256 =
      "e".repeat(64);

    expect(() =>
      verify(saved),
    ).toThrow(
      "Native M4 manifest identity mismatch",
    );
  });

  it("rejects incomplete and failed reports", () => {
    const incomplete = manifest();

    incomplete.report.assignedShots = 1;

    expect(() =>
      verify(incomplete),
    ).toThrow(
      "Native M4 manifest shot coverage mismatch",
    );

    const failed = manifest();

    failed.report.passed = false;

    expect(() =>
      verify(failed),
    ).toThrow();
  });

  it("rejects missing or reordered assignments", () => {
    const missing = manifest();

    missing.report.assignments.pop();

    expect(() =>
      verify(missing),
    ).toThrow(
      "Native M4 manifest shot coverage mismatch",
    );

    const reordered = manifest();

    reordered.report.assignments.reverse();

    expect(() =>
      verify(reordered),
    ).toThrow(
      "Native M4 assignment order mismatch",
    );
  });

  it("rejects mismatched job identity and duplicate shot IDs", () => {
    const wrongJob = manifest();

    wrongJob.jobId = "another-job";

    expect(() =>
      verify(wrongJob),
    ).toThrow(
      "Native M4 manifest identity mismatch",
    );

    expect(() =>
      verify(
        manifest(),
        {
          shotIds: [
            "shot-001",
            "shot-001",
          ],
        },
      ),
    ).toThrow(
      "Native M4 shot IDs are empty or duplicated",
    );
  });
});
