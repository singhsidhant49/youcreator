import { describe, expect, it } from "vitest";

import {
  createEditorialNarrativePlan,
  verifyEditorialNarrativePlan,
} from "./editorial-narrative-plan.js";

const input = {
  topic: "How artificial intelligence learns language",
  profile: "explainer" as const,
  targetDurationSeconds: 60,
  wordsPerMinute: 160,
};

describe("M10.5 narrative planning", () => {
  it("creates deterministic plans", () => {
    expect(createEditorialNarrativePlan(input))
      .toEqual(createEditorialNarrativePlan(input));
  });

  it("verifies canonical identity", () => {
    const plan = createEditorialNarrativePlan(input);
    expect(verifyEditorialNarrativePlan(plan, input))
      .toEqual(plan);
  });

  it("rejects altered narrative plans", () => {
    const plan = createEditorialNarrativePlan(input);
    expect(() =>
      verifyEditorialNarrativePlan(
        { ...plan, targetWords: 200 },
        input,
      ),
    ).toThrow("M10.5 narrative plan identity mismatch");
  });

  it("includes a hook and payoff", () => {
    const beats = createEditorialNarrativePlan(input)
      .beats.map((beat) => beat.beat);

    expect(beats[0]).toBe("hook");
    expect(beats).toContain("payoff");
    expect(beats.at(-1)).toBe("closing");
  });

  it("creates profile-specific structures", () => {
    const documentary = createEditorialNarrativePlan({
      ...input,
      profile: "documentary",
    });

    const story = createEditorialNarrativePlan({
      ...input,
      profile: "story",
    });

    expect(documentary.planHash).not.toBe(
      story.planHash,
    );
    expect(documentary.beats).not.toEqual(story.beats);
  });

  it("calculates narration word budget", () => {
    const plan = createEditorialNarrativePlan(input);
    expect(plan.targetWords).toBe(160);
  });

  it("maintains normalized beat shares", () => {
    for (const profile of [
      "explainer",
      "documentary",
      "story",
    ] as const) {
      const plan = createEditorialNarrativePlan({
        ...input,
        profile,
      });

      const share = plan.beats.reduce(
        (total, beat) => total + beat.targetWordShare,
        0,
      );

      expect(share).toBeCloseTo(1);
    }
  });

  it("rejects impossible speaking rates", () => {
    expect(() =>
      createEditorialNarrativePlan({
        ...input,
        wordsPerMinute: 500,
      }),
    ).toThrow();
  });
});
