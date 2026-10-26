import {
  describe,
  expect,
  it,
} from "vitest";

import type { MediaAsset } from "@youcreator/contracts";
import type { AssignedMedia } from "./assigned-media.js";
import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  createShotMediaBindings,
} from "./shot-media-binding.js";

import {
  createShotMotionPlan,
} from "./shot-motion-plan.js";

import {
  calculateSafeCoverCrop,
  createShotFrameGeometry,
} from "./shot-frame-geometry.js";

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
  width = 1920,
  height = 1080,
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
  width = 1920,
  height = 1080,
  durations = [1.25, 2.35, 1.4],
) {
  const assignments = [
    assigned("shot-001", "a", width, height),
    assigned("shot-002", "b"),
    assigned("shot-003", "c"),
  ];

  const report: MediaResolutionReport = {
    version: 1,
    jobId: "job-m5-geometry",
    mode: "B",
    expectedShots: 3,
    assignedShots: 3,
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
      jobId: "job-m5-geometry",
      mode: "B",
      shotIds: [
        "shot-001",
        "shot-002",
        "shot-003",
      ],
    },
    report,
    productionPackageHash: "d".repeat(64),
    mediaManifestHash: "e".repeat(64),
  });

  const shotDurations = durations.map(
    (durationSeconds, index) => ({
      shotId: `shot-00${index + 1}`,
      durationSeconds,
    }),
  );

  const motionPlan = createShotMotionPlan({
    bindings,
    durations: shotDurations,
  });

  let cursor = 0;

  const timings = shotDurations.map((item) => {
    const startSeconds = cursor;
    cursor += item.durationSeconds;

    return {
      shotId: item.shotId,
      startSeconds,
      endSeconds: cursor,
    };
  });

  return { motionPlan, timings };
}

describe("Shot frame geometry", () => {
  it("preserves canonical shot order and contiguous frames", () => {
    const result = createShotFrameGeometry(
      fixture(),
    );

    expect(
      result.shots.map((shot) => shot.shotId),
    ).toEqual([
      "shot-001",
      "shot-002",
      "shot-003",
    ]);

    for (let index = 1; index < result.shots.length; index++) {
      expect(result.shots[index]!.startFrame).toBe(
        result.shots[index - 1]!.endFrameExclusive,
      );
    }
  });

  it("rounds cumulative timeline boundaries without drift", () => {
    const result = createShotFrameGeometry({
      ...fixture(),
      fps: 30,
    });

    expect(result.totalFrames).toBe(150);

    expect(
      result.shots.map((shot) => shot.endFrameExclusive),
    ).toEqual([38, 108, 150]);

    expect(
      result.shots.map((shot) => shot.durationFrames),
    ).toEqual([38, 70, 42]);
  });

  it("creates deterministic frame geometry hashes", () => {
    const input = fixture();

    const first = createShotFrameGeometry(input);
    const second = createShotFrameGeometry(input);

    expect(first).toEqual(second);
    expect(first.geometryPackageHash).toBe(
      second.geometryPackageHash,
    );
  });

  it("keeps cover crop entirely within source bounds", () => {
    const input = fixture(1920, 1080);

    const result = createShotFrameGeometry(input);

    for (const shot of result.shots) {
      if (shot.fit !== "cover") continue;

      for (const crop of [
        shot.startCrop,
        shot.endCrop,
      ]) {
        expect(crop).not.toBeNull();

        if (!crop) continue;

        expect(crop.left).toBeGreaterThanOrEqual(0);
        expect(crop.top).toBeGreaterThanOrEqual(0);

        expect(
          crop.left + crop.width,
        ).toBeLessThanOrEqual(
          shot.sourceWidth + 0.00001,
        );

        expect(
          crop.top + crop.height,
        ).toBeLessThanOrEqual(
          shot.sourceHeight + 0.00001,
        );
      }
    }
  });

  it("uses no crop for contained portrait images", () => {
    const result = createShotFrameGeometry(
      fixture(720, 1280),
    );

    expect(result.shots[0]?.fit).toBe("contain");
    expect(result.shots[0]?.startCrop).toBeNull();
    expect(result.shots[0]?.endCrop).toBeNull();
  });

  it("rejects timeline gaps and overlaps", () => {
    const gap = fixture();

    gap.timings[1]!.startSeconds += 0.2;

    expect(() =>
      createShotFrameGeometry(gap),
    ).toThrow("Timeline gap or overlap");

    const overlap = fixture();

    overlap.timings[1]!.startSeconds -= 0.2;

    expect(() =>
      createShotFrameGeometry(overlap),
    ).toThrow("Timeline gap or overlap");
  });

  it("rejects reordered shots and duration disagreements", () => {
    const reordered = fixture();

    [
      reordered.timings[0],
      reordered.timings[1],
    ] = [
      reordered.timings[1]!,
      reordered.timings[0]!,
    ];

    expect(() =>
      createShotFrameGeometry(reordered),
    ).toThrow("Noncanonical timeline shot order");

    const mismatch = fixture();

    mismatch.timings[2]!.endSeconds += 0.1;

    expect(() =>
      createShotFrameGeometry(mismatch),
    ).toThrow(
      "Motion duration disagrees with M3 timeline",
    );
  });

  it("rejects shots shorter than one frame", () => {
    const input = fixture(
      1920,
      1080,
      [0.001, 2.35, 1.4],
    );

    expect(() =>
      createShotFrameGeometry({
        ...input,
        fps: 30,
      }),
    ).toThrow(
      "Shot is shorter than one output frame",
    );
  });
});
