import { describe, expect, it } from "vitest";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
  type SceneMediaPlan,
} from "./scene-media-plan.js";

import {
  evaluateMediaRequirementQA,
} from "./media-requirement-qa.js";

import {
  storyboard,
} from "./visual-continuity.test-fixture.js";

const continuity = planVisualContinuity(
  storyboard,
  "documentary",
);

function plan(
  mode: SceneMediaPlan["mode"],
): SceneMediaPlan {
  return createSceneMediaPlan(
    storyboard,
    continuity,
    mode,
  );
}

describe("Media requirement QA", () => {
  it("accepts a complete stock media plan", () => {
    const result = evaluateMediaRequirementQA(
      plan("B"),
    );

    expect(result.passed).toBe(true);
    expect(result.checkedShots).toBe(3);
    expect(result.blockers).toEqual([]);
  });

  it("blocks stock shots without search queries", () => {
    const input = plan("B");

    input.shots[0]!.searchQueries = [];

    const result = evaluateMediaRequirementQA(
      input,
    );

    expect(result.passed).toBe(false);

    expect(
      result.blockers.some(
        (issue) =>
          issue.code === "EMPTY_SEARCH_QUERIES",
      ),
    ).toBe(true);
  });

  it("warns about duplicate stock searches", () => {
    const input = plan("B");

    input.shots[0]!.searchQueries = [
      "person working at desk",
      "Person Working At Desk",
    ];

    const result = evaluateMediaRequirementQA(
      input,
    );

    expect(result.passed).toBe(true);

    expect(
      result.warnings.some(
        (issue) =>
          issue.code === "DUPLICATE_SEARCH_QUERY",
      ),
    ).toBe(true);
  });

  it("blocks insufficiently detailed AI prompts", () => {
    const input = plan("C");

    input.shots[0]!.continuityPrompt =
      "A person at a desk.";

    const result = evaluateMediaRequirementQA(
      input,
    );

    expect(result.passed).toBe(false);

    expect(
      result.blockers.some(
        (issue) => issue.code === "WEAK_AI_PROMPT",
      ),
    ).toBe(true);
  });

  it("blocks missing explicit identity instructions", () => {
    const input = plan("C");

    input.shots[0]!.identityReferencesRequired = [
      "character-alex",
    ];

    const result = evaluateMediaRequirementQA(
      input,
    );

    expect(
      result.blockers.some(
        (issue) =>
          issue.code ===
          "MISSING_IDENTITY_INSTRUCTIONS",
      ),
    ).toBe(true);
  });

  it("detects conflicting shared background media kinds", () => {
    const input = plan("A");

    input.shots[0]!.preferredMediaKind = "image";
    input.shots[1]!.preferredMediaKind = "video";

    const result = evaluateMediaRequirementQA(
      input,
    );

    expect(result.passed).toBe(false);

    expect(
      result.blockers.some(
        (issue) =>
          issue.code ===
          "SHARED_GROUP_MEDIA_CONFLICT",
      ),
    ).toBe(true);
  });

  it("warns rather than blocks unresolved manual assets", () => {
    const result = evaluateMediaRequirementQA(
      plan("D"),
    );

    expect(result.passed).toBe(true);
    expect(result.blockers).toHaveLength(0);

    expect(
      result.warnings.filter(
        (issue) =>
          issue.code === "MANUAL_ASSET_UNRESOLVED",
      ),
    ).toHaveLength(3);
  });

  it("rejects invalid QA thresholds", () => {
    expect(() =>
      evaluateMediaRequirementQA(
        plan("B"),
        {
          minimumSearchQueryCharacters: -1,
        },
      ),
    ).toThrow("Invalid media QA thresholds");
  });
});
