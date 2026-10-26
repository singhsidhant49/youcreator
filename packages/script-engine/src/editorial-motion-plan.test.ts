import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createEditorialMotionPlan,
  verifyEditorialMotionPlan,
} from "./editorial-motion-plan.js";

import {
  evaluateEditorialFrame,
} from "./editorial-motion-evaluator.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function fixture() {
  return {
    profile: "documentary" as const,
    fps: 30,
    shots: [
      {
        shotId: "shot-a",
        assetSha256: A,
        startFrame: 0,
        endFrameExclusive: 120,
      },
      {
        shotId: "shot-b",
        assetSha256: B,
        startFrame: 120,
        endFrameExclusive: 240,
      },
      {
        shotId: "shot-c",
        assetSha256: C,
        startFrame: 240,
        endFrameExclusive: 360,
      },
    ],
  };
}

describe("M10.3 editorial motion planning", () => {
  it("creates deterministic plans", () => {
    const input = fixture();

    const first = createEditorialMotionPlan(input);
    const second = createEditorialMotionPlan(input);

    expect(first).toEqual(second);
    expect(first.planHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("reconstructs the canonical plan", () => {
    const input = fixture();
    const plan = createEditorialMotionPlan(input);

    expect(
      verifyEditorialMotionPlan(plan, input),
    ).toEqual(plan);
  });

  it("rejects altered motion identity", () => {
    const input = fixture();
    const plan = createEditorialMotionPlan(input);

    expect(() =>
      verifyEditorialMotionPlan(
        {
          ...plan,
          planHash: B,
        },
        input,
      ),
    ).toThrow(
      "M10.3 motion plan reconstruction mismatch",
    );
  });

  it("preserves source shot timing", () => {
    const input = fixture();
    const plan = createEditorialMotionPlan(input);

    for (let i = 0; i < input.shots.length; i++) {
      expect(plan.shots[i]!.startFrame).toBe(
        input.shots[i]!.startFrame,
      );
      expect(plan.shots[i]!.endFrameExclusive).toBe(
        input.shots[i]!.endFrameExclusive,
      );
    }
  });

  it("avoids noticeable movement on micro-shots", () => {
    const input = {
      profile: "explainer" as const,
      fps: 30,
      shots: [{
        shotId: "short",
        assetSha256: A,
        startFrame: 0,
        endFrameExclusive: 45,
      }],
    };

    const plan = createEditorialMotionPlan(input);

    expect(plan.shots[0]!.movement).toBe("static");
    expect(plan.shots[0]!.startScale).toBe(
      plan.shots[0]!.endScale,
    );
  });

  it("rejects overlapping shot timelines", () => {
    const input = fixture();
    input.shots[1]!.startFrame = 110;

    expect(() =>
      createEditorialMotionPlan(input),
    ).toThrow(
      "M10.3 invalid editorial shot timeline",
    );
  });

  it("rejects duplicate shot IDs", () => {
    const input = fixture();
    input.shots[1]!.shotId = "shot-a";

    expect(() =>
      createEditorialMotionPlan(input),
    ).toThrow(
      "M10.3 invalid editorial shot timeline",
    );
  });

  it("generates valid motion transforms", () => {
    const plan = createEditorialMotionPlan(
      fixture(),
    );

    const frame = evaluateEditorialFrame(
      plan,
      0,
      60,
    );

    expect(frame.scale).toBeGreaterThanOrEqual(1);
    expect(frame.scale).toBeLessThanOrEqual(1.15);
    expect(frame.opacity).toBe(1);
    expect(
      Number.isFinite(frame.translateXPercent),
    ).toBe(true);
  });

  it("keeps shot movement within configured bounds", () => {
    const plan = createEditorialMotionPlan(
      fixture(),
    );

    for (const shot of plan.shots) {
      expect(shot.startScale).toBeLessThanOrEqual(
        1.15,
      );
      expect(shot.endScale).toBeLessThanOrEqual(
        1.15,
      );
      expect(Math.abs(shot.startX)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(shot.endX)).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("rejects invalid frame input", () => {
    const plan = createEditorialMotionPlan(
      fixture(),
    );

    expect(() =>
      evaluateEditorialFrame(
        plan,
        0,
        -1,
      ),
    ).toThrow(
      "M10.3 invalid evaluation frame",
    );
  });
});
