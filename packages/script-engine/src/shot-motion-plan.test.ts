import {
  describe,
  expect,
  it,
} from "vitest";

import type { MediaAsset } from "@youcreator/contracts";

import type {
  AssignedMedia,
} from "./assigned-media.js";

import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  createShotMediaBindings,
} from "./shot-media-binding.js";

import {
  createShotMotionPlan,
} from "./shot-motion-plan.js";

function asset(
  letter: string,
  width = 1920,
  height = 1080,
): MediaAsset {
  return {
    version: 1,
    id: `asset-${letter}`,
    kind: "image",
    localPath: `/objects/${letter}.png`,
    sha256: letter.repeat(64),
    bytes: 100,
    mimeType: "image/png",
    width,
    height,
    provenance: {
      source: "local_library",
      providerAssetId: `bank-${letter}`,
      license: {
        status: "unknown",
      },
    },
    createdAt: "2026-10-13T10:00:00.000Z",
  };
}

function assigned(
  shotId: string,
  letter: string,
  width?: number,
  height?: number,
): AssignedMedia {
  return {
    version: 1,
    shotId,
    mode: "B",
    assignmentSource: "local_library",
    assignedAt: "2026-10-13T10:00:00.000Z",
    asset: asset(letter, width, height),
  };
}

function fixture(
  imageWidth = 1920,
  imageHeight = 1080,
) {
  const assignments = [
    assigned("shot-001", "a", imageWidth, imageHeight),
    assigned("shot-002", "b"),
  ];

  const report: MediaResolutionReport = {
    version: 1,
    jobId: "job-m5-motion",
    mode: "B",
    expectedShots: 2,
    assignedShots: 2,
    outcomes: assignments.map(
      (assignment) => ({
        status: "assigned" as const,
        assignment,
      }),
    ),
    assignments,
    issues: [],
    passed: true,
  };

  const bindings = createShotMediaBindings({
    request: {
      jobId: "job-m5-motion",
      mode: "B",
      shotIds: ["shot-001", "shot-002"],
    },
    report,
    productionPackageHash: "c".repeat(64),
    mediaManifestHash: "d".repeat(64),
  });

  return {
    bindings,
    durations: [
      { shotId: "shot-001", durationSeconds: 4 },
      { shotId: "shot-002", durationSeconds: 5 },
    ],
  };
}

describe("Deterministic shot motion planning", () => {
  it("preserves canonical shot order and duration", () => {
    const plan = createShotMotionPlan(fixture());

    expect(
      plan.shots.map((shot) => shot.shotId),
    ).toEqual(["shot-001", "shot-002"]);

    expect(
      plan.shots.map((shot) => shot.durationSeconds),
    ).toEqual([4, 5]);

    expect(
      plan.shots.map((shot) => shot.shotIndex),
    ).toEqual([0, 1]);
  });

  it("creates deterministic motion package hashes", () => {
    const input = fixture();

    const first = createShotMotionPlan(input);
    const second = createShotMotionPlan(input);

    expect(first).toEqual(second);
    expect(first.motionPackageHash).toBe(
      second.motionPackageHash,
    );
  });

  it("uses cover for landscape images", () => {
    const plan = createShotMotionPlan(fixture());

    expect(plan.shots[0]?.fit).toBe("cover");
    expect(plan.shots[0]?.frameWidth).toBe(1920);
    expect(plan.shots[0]?.frameHeight).toBe(1080);
  });

  it("uses contain for extreme portrait mismatch", () => {
    const plan = createShotMotionPlan(
      fixture(720, 1280),
    );

    expect(plan.shots[0]?.fit).toBe("contain");
    expect(plan.shots[0]?.motion).toBe("static");
  });

  it("keeps movement inside bounded ranges", () => {
    const plan = createShotMotionPlan(fixture());

    for (const shot of plan.shots) {
      expect(shot.startScale).toBeGreaterThanOrEqual(1);
      expect(shot.endScale).toBeLessThanOrEqual(1.2);

      for (const position of [
        shot.startX,
        shot.endX,
        shot.startY,
        shot.endY,
      ]) {
        expect(position).toBeGreaterThanOrEqual(0);
        expect(position).toBeLessThanOrEqual(1);
      }
    }
  });

  it("uses static motion for short shots", () => {
    const input = fixture();

    input.durations[0]!.durationSeconds = 1.5;

    const plan = createShotMotionPlan(input);

    expect(plan.shots[0]?.motion).toBe("static");
    expect(plan.shots[0]?.startScale).toBe(1);
    expect(plan.shots[0]?.endScale).toBe(1);
  });

  it("rejects missing or duplicate shot durations", () => {
    const missing = fixture();
    missing.durations.pop();

    expect(() =>
      createShotMotionPlan(missing),
    ).toThrow("Shot duration coverage");

    const duplicate = fixture();
    duplicate.durations[1] = {
      shotId: "shot-001",
      durationSeconds: 5,
    };

    expect(() =>
      createShotMotionPlan(duplicate),
    ).toThrow("Duplicate shot duration");
  });

  it("changes plan identity when duration changes", () => {
    const first = fixture();
    const second = fixture();

    second.durations[0]!.durationSeconds = 8;

    expect(
      createShotMotionPlan(first).motionPackageHash,
    ).not.toBe(
      createShotMotionPlan(second).motionPackageHash,
    );
  });
});
