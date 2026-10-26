import { describe, expect, it } from "vitest";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
  validateSceneMediaPlan,
} from "./scene-media-plan.js";

import {
  storyboard,
} from "./visual-continuity.test-fixture.js";

const continuity = planVisualContinuity(
  storyboard,
  "documentary",
  {
    identities: [
      {
        id: "character-alex",
        type: "subject",
        description:
          "Alex, adult with dark hair and blue jacket",
        consistencyRules:
          "Preserve identical face, hairstyle and jacket",
      },
    ],
    assignments: [
      {
        shotId: "shot-001",
        identityIds: ["character-alex"],
      },
      {
        shotId: "shot-002",
        identityIds: [],
      },
      {
        shotId: "shot-003",
        identityIds: [],
      },
    ],
  },
);

describe("Scene media planning", () => {
  it("creates requirements for every storyboard shot", () => {
    const plan = createSceneMediaPlan(
      storyboard,
      continuity,
      "B",
    );

    expect(plan.shots).toHaveLength(3);

    expect(
      validateSceneMediaPlan(
        storyboard,
        continuity,
        plan,
      ).passed,
    ).toBe(true);
  });

  it("uses AI generation strategy in Mode C", () => {
    const plan = createSceneMediaPlan(
      storyboard,
      continuity,
      "C",
    );

    expect(
      plan.shots.every(
        (shot) =>
          shot.strategy === "ai_generation",
      ),
    ).toBe(true);
  });

  it("preserves explicit identity requirements", () => {
    const plan = createSceneMediaPlan(
      storyboard,
      continuity,
      "C",
    );

    expect(
      plan.shots[0]?.identityReferencesRequired,
    ).toEqual(["character-alex"]);

    expect(
      plan.shots[1]?.identityReferencesRequired,
    ).toEqual([]);
  });

  it("groups atmospheric assets in Mode A", () => {
    const plan = createSceneMediaPlan(
      storyboard,
      continuity,
      "A",
    );

    expect(
      plan.shots.every(
        (shot) =>
          shot.strategy === "shared_background",
      ),
    ).toBe(true);

    expect(
      new Set(
        plan.shots.map(
          (shot) => shot.sharedAssetGroupId,
        ),
      ).size,
    ).toBe(1);
  });

  it("requires manual asset resolution in Mode D", () => {
    const plan = createSceneMediaPlan(
      storyboard,
      continuity,
      "D",
    );

    expect(
      plan.shots.every(
        (shot) => shot.strategy === "manual_asset",
      ),
    ).toBe(true);
  });

  it("detects missing media requirements", () => {
    const plan = createSceneMediaPlan(
      storyboard,
      continuity,
      "B",
    );

    const invalid = structuredClone(plan);
    invalid.shots.pop();

    const result = validateSceneMediaPlan(
      storyboard,
      continuity,
      invalid,
    );

    expect(result.passed).toBe(false);

    expect(
      result.issues.some(
        (issue) => issue.code === "MISSING_SHOT",
      ),
    ).toBe(true);
  });

  it("detects removed explicit identity references", () => {
    const plan = createSceneMediaPlan(
      storyboard,
      continuity,
      "C",
    );

    const invalid = structuredClone(plan);

    invalid.shots[0]!
      .identityReferencesRequired = [];

    const result = validateSceneMediaPlan(
      storyboard,
      continuity,
      invalid,
    );

    expect(result.passed).toBe(false);

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "UNKNOWN_IDENTITY",
      ),
    ).toBe(true);
  });
});
