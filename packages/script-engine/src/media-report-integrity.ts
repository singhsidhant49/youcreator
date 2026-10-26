import {
  AssignedMediaSchema,
  MediaAssignmentOutcomeSchema,
  type AssignedMedia,
} from "./assigned-media.js";

import {
  MediaResolutionRequestSchema,
  type MediaResolutionRequest,
  type MediaResolutionReport,
} from "./media-resolution-coordinator.js";

export interface MediaReportIntegrityResult {
  expectedShotIds: string[];
  assignedShotIds: string[];
  unresolvedShotIds: string[];
  complete: boolean;
}

function fail(message: string): never {
  throw new Error(
    `Media report integrity failure: ${message}`,
  );
}

function assignmentMatches(
  a: AssignedMedia,
  b: AssignedMedia,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function verifyMediaResolutionReport(
  input: MediaResolutionRequest,
  report: MediaResolutionReport,
): MediaReportIntegrityResult {
  const request =
    MediaResolutionRequestSchema.parse(input);

  if (report.version !== 1) {
    fail("Unsupported report version");
  }

  if (report.jobId !== request.jobId) {
    fail("Job ID mismatch");
  }

  if (report.mode !== request.mode) {
    fail("Media mode mismatch");
  }

  const expected = new Set(
    request.shotIds,
  );

  if (
    report.expectedShots !== expected.size
  ) {
    fail("Expected shot count mismatch");
  }

  const outcomeIds = new Set<string>();
  const unresolvedIds = new Set<string>();

  const successfulOutcomes =
    new Map<string, AssignedMedia>();

  for (const raw of report.outcomes) {
    const outcome =
      MediaAssignmentOutcomeSchema.parse(raw);

    const shotId =
      outcome.status === "assigned"
        ? outcome.assignment.shotId
        : outcome.shotId;

    if (!expected.has(shotId)) {
      fail(`Unknown outcome shot: ${shotId}`);
    }

    if (outcomeIds.has(shotId)) {
      fail(`Duplicate outcome shot: ${shotId}`);
    }

    outcomeIds.add(shotId);

    if (outcome.status === "unresolved") {
      unresolvedIds.add(shotId);
      continue;
    }

    if (
      outcome.assignment.mode !== request.mode
    ) {
      fail(
        `Outcome mode mismatch: ${shotId}`,
      );
    }

    successfulOutcomes.set(
      shotId,
      outcome.assignment,
    );
  }

  const assignmentIds =
    new Set<string>();

  for (const raw of report.assignments) {
    const assignment =
      AssignedMediaSchema.parse(raw);

    const shotId = assignment.shotId;

    if (!expected.has(shotId)) {
      fail(`Unknown assignment shot: ${shotId}`);
    }

    if (assignmentIds.has(shotId)) {
      fail(`Duplicate assignment shot: ${shotId}`);
    }

    if (assignment.mode !== request.mode) {
      fail(
        `Assignment mode mismatch: ${shotId}`,
      );
    }

    const corresponding =
      successfulOutcomes.get(shotId);

    if (!corresponding) {
      fail(
        `Assignment has no successful outcome: ${shotId}`,
      );
    }

    if (
      !assignmentMatches(
        assignment,
        corresponding,
      )
    ) {
      fail(
        `Assignment differs from outcome: ${shotId}`,
      );
    }

    assignmentIds.add(shotId);
  }

  if (
    report.assignedShots !==
    assignmentIds.size
  ) {
    fail("Assigned shot count mismatch");
  }

  const hasBlocker = report.issues.some(
    (issue) =>
      issue.severity === "blocker",
  );

  const complete =
    assignmentIds.size === expected.size &&
    outcomeIds.size === expected.size &&
    unresolvedIds.size === 0 &&
    !hasBlocker;

  if (report.passed !== complete) {
    fail(
      "Report passed status does not match actual QA",
    );
  }

  if (report.passed) {
    for (const shotId of request.shotIds) {
      if (!assignmentIds.has(shotId)) {
        fail(
          `Missing accepted assignment: ${shotId}`,
        );
      }
    }
  }

  return {
    expectedShotIds: [...request.shotIds],
    assignedShotIds: [
      ...assignmentIds,
    ],
    unresolvedShotIds: [
      ...unresolvedIds,
    ],
    complete,
  };
}
