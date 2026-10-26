import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  MediaAsset,
} from "@youcreator/contracts";

import type {
  AssignedMedia,
} from "./assigned-media.js";

import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  verifyMediaResolutionReport,
} from "./media-report-integrity.js";

const request = {
  jobId: "job-media-001",
  mode: "B" as const,
  shotIds: [
    "shot-001",
    "shot-002",
  ],
};

function asset(
  letter: string,
): MediaAsset {
  return {
    version: 1,
    id: `asset-${letter}`,
    kind: "image",
    localPath: `/test/${letter}.png`,
    sha256: letter.repeat(64),
    bytes: 100,
    mimeType: "image/png",
    width: 1920,
    height: 1080,
    provenance: {
      source: "local_library",
      license: {
        status: "unknown",
      },
    },
    createdAt:
      "2026-10-12T10:00:00.000Z",
  };
}

function assignment(
  shotId: string,
  letter: string,
): AssignedMedia {
  return {
    version: 1,
    shotId,
    mode: "B",
    assignmentSource: "local_library",
    asset: asset(letter),
    assignedAt:
      "2026-10-12T10:00:00.000Z",
  };
}

function validReport(): MediaResolutionReport {
  const assignments = [
    assignment("shot-001", "a"),
    assignment("shot-002", "b"),
  ];

  return {
    version: 1,
    jobId: request.jobId,
    mode: "B",
    expectedShots: 2,
    assignedShots: 2,
    outcomes: assignments.map(
      (item) => ({
        status: "assigned" as const,
        assignment: item,
      }),
    ),
    assignments,
    issues: [],
    passed: true,
  };
}

describe("Media report integrity", () => {
  it("accepts a complete consistent report", () => {
    const result =
      verifyMediaResolutionReport(
        request,
        validReport(),
      );

    expect(result.complete).toBe(true);

    expect(result.assignedShotIds)
      .toEqual([
        "shot-001",
        "shot-002",
      ]);
  });

  it("rejects a false successful report", () => {
    const report = validReport();

    report.assignments = [
      report.assignments[0]!,
    ];

    report.assignedShots = 1;

    expect(() =>
      verifyMediaResolutionReport(
        request,
        report,
      ),
    ).toThrow(
      "passed status",
    );
  });

  it("rejects duplicate outcomes", () => {
    const report = validReport();

    report.outcomes.push(
      report.outcomes[0]!,
    );

    expect(() =>
      verifyMediaResolutionReport(
        request,
        report,
      ),
    ).toThrow(
      "Duplicate outcome shot",
    );
  });

  it("rejects unknown shot assignments", () => {
    const report = validReport();

    report.assignments[1] = assignment(
      "shot-unknown",
      "b",
    );

    expect(() =>
      verifyMediaResolutionReport(
        request,
        report,
      ),
    ).toThrow(
      "Unknown assignment shot",
    );
  });

  it("rejects assignment and outcome asset mismatch", () => {
    const report = validReport();

    report.assignments[0] = assignment(
      "shot-001",
      "c",
    );

    expect(() =>
      verifyMediaResolutionReport(
        request,
        report,
      ),
    ).toThrow(
      "Assignment differs from outcome",
    );
  });

  it("rejects incorrect report counts", () => {
    const report = validReport();

    report.assignedShots = 3;

    expect(() =>
      verifyMediaResolutionReport(
        request,
        report,
      ),
    ).toThrow(
      "Assigned shot count mismatch",
    );
  });

  it("rejects blocker issues in successful reports", () => {
    const report = validReport();

    report.issues.push({
      code: "RESOLUTION_FAILED",
      severity: "blocker",
      shotId: "shot-002",
      message: "Source unavailable",
    });

    expect(() =>
      verifyMediaResolutionReport(
        request,
        report,
      ),
    ).toThrow(
      "passed status",
    );
  });

  it("accepts an honest incomplete report", () => {
    const report = validReport();

    report.outcomes[1] = {
      status: "unresolved",
      shotId: "shot-002",
      reason: "MISSING_ASSET",
      message: "Image unavailable",
    };

    report.assignments = [
      report.assignments[0]!,
    ];

    report.assignedShots = 1;
    report.passed = false;

    report.issues = [{
      code: "RESOLUTION_FAILED",
      severity: "blocker",
      shotId: "shot-002",
      message: "Image unavailable",
    }];

    const result =
      verifyMediaResolutionReport(
        request,
        report,
      );

    expect(result.complete).toBe(false);

    expect(result.unresolvedShotIds)
      .toEqual(["shot-002"]);
  });
});
