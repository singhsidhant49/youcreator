import { describe, expect, it } from "vitest";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import { storyboard } from "./visual-continuity.test-fixture.js";

describe("Visual continuity planning", () => {
  it("creates a continuity entry for every shot", () => {
    const result = planVisualContinuity(storyboard);

    expect(result.shots).toHaveLength(3);
    expect(result.shots.map((s) => s.shotId)).toEqual([
      "shot-001",
      "shot-002",
      "shot-003",
    ]);
  });

  it("reuses provisional subject anchors", () => {
    const result = planVisualContinuity(storyboard);

    const first = result.shots[0]!;
    const second = result.shots[1]!;

    expect(first.anchorIds).toHaveLength(1);
    expect(second.anchorIds).toEqual(first.anchorIds);
    expect(result.anchors).toHaveLength(1);
  });

  it("does not invent a subject anchor for a clock", () => {
    const result = planVisualContinuity(storyboard);

    expect(result.shots[2]?.anchorIds).toEqual([]);
  });

  it("varies shot framing and camera angles", () => {
    const result = planVisualContinuity(storyboard);

    expect(
      new Set(result.shots.map((s) => s.framing)).size,
    ).toBeGreaterThan(1);

    expect(
      new Set(result.shots.map((s) => s.cameraAngle)).size,
    ).toBeGreaterThan(1);
  });

  it("supports meditation visual styling", () => {
    const result = planVisualContinuity(
      storyboard,
      "meditation",
    );

    expect(result.profile).toBe("meditation");
    expect(result.styleGuide).toContain(
      "Calm atmospheric landscapes",
    );
  });

  it("is deterministic for identical storyboards", () => {
    const first = planVisualContinuity(storyboard);
    const second = planVisualContinuity(storyboard);

    expect(first).toEqual(second);
  });

  it("does not modify the original storyboard", () => {
    const original = structuredClone(storyboard);

    planVisualContinuity(storyboard);

    expect(storyboard).toEqual(original);
  });
});
