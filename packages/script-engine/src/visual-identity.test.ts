import {
  describe,
  expect,
  it,
} from "vitest";

import {
  planVisualContinuity,
  validateVisualContinuity,
} from "./visual-continuity.js";

import { storyboard } from "./visual-continuity.test-fixture.js";

const identities = {
  identities: [
    {
      id: "character-alex",
      type: "subject" as const,
      description:
        "Alex, an adult with short dark hair and a blue jacket",
      consistencyRules:
        "Keep the same facial features, hairstyle and jacket",
    },
    {
      id: "character-maya",
      type: "subject" as const,
      description:
        "Maya, an adult with curly hair and a green sweater",
      consistencyRules:
        "Keep the same facial features, hairstyle and sweater",
    },
  ],
  assignments: [
    {
      shotId: "shot-001",
      identityIds: ["character-alex"],
    },
    {
      shotId: "shot-002",
      identityIds: ["character-maya"],
    },
    {
      shotId: "shot-003",
      identityIds: [],
    },
  ],
};

describe("Explicit visual identities", () => {
  it("keeps separate characters separate", () => {
    const plan = planVisualContinuity(
      storyboard,
      "documentary",
      identities,
    );

    expect(plan.shots[0]?.anchorIds).toEqual([
      "character-alex",
    ]);

    expect(plan.shots[1]?.anchorIds).toEqual([
      "character-maya",
    ]);
  });

  it("supports explicit identity-free shots", () => {
    const plan = planVisualContinuity(
      storyboard,
      "documentary",
      identities,
    );

    expect(plan.shots[2]?.anchorIds).toEqual([]);
  });

  it("includes character consistency rules", () => {
    const plan = planVisualContinuity(
      storyboard,
      "documentary",
      identities,
    );

    expect(
      plan.shots[0]?.continuityPrompt,
    ).toContain("character-alex");

    expect(
      plan.shots[0]?.continuityPrompt,
    ).toContain("same facial features");
  });

  it("rejects unknown identity references", () => {
    expect(() =>
      planVisualContinuity(
        storyboard,
        "documentary",
        {
          identities: [],
          assignments: [{
            shotId: "shot-001",
            identityIds: ["missing-character"],
          }],
        },
      ),
    ).toThrow("Unknown explicit identity");
  });

  it("rejects unknown shot assignments", () => {
    expect(() =>
      planVisualContinuity(
        storyboard,
        "documentary",
        {
          identities: [],
          assignments: [{
            shotId: "shot-not-found",
            identityIds: [],
          }],
        },
      ),
    ).toThrow("unknown shot");
  });

  it("rejects duplicate identity definitions", () => {
    expect(() =>
      planVisualContinuity(
        storyboard,
        "documentary",
        {
          identities: [
            identities.identities[0]!,
            identities.identities[0]!,
          ],
        },
      ),
    ).toThrow("Duplicate explicit identity");
  });

  it("validates exact continuity shot coverage", () => {
    const plan = planVisualContinuity(
      storyboard,
      "documentary",
      identities,
    );

    const valid = validateVisualContinuity(
      storyboard,
      plan,
    );

    expect(valid.passed).toBe(true);

    const modified = structuredClone(plan);
    modified.shots.pop();

    const invalid = validateVisualContinuity(
      storyboard,
      modified,
    );

    expect(invalid.passed).toBe(false);

    expect(
      invalid.issues.some(
        (issue) => issue.code === "MISSING_SHOT",
      ),
    ).toBe(true);
  });
});
