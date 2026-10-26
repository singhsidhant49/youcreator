import { describe, expect, it } from "vitest";

import { OutlinePlanner } from "./outline-planner.js";

const validOutline = {
  version: 1,
  title: "Why Humans Procrastinate",
  centralIdea: "Procrastination involves emotional regulation.",
  hookPlan: "Open with a relatable question.",
  hookTargetWords: 20,
  sections: [
    {
      id: "section-001",
      title: "Why We Delay",
      objective: "Explain the psychological mechanism.",
      keyPoints: [
        "Emotional avoidance",
        "Short-term reward",
      ],
      targetWords: 100,
    },
  ],
  outroPlan: "Offer a practical takeaway.",
  outroTargetWords: 15,
};

describe("OutlinePlanner", () => {
  it("creates a valid outline", async () => {
    const planner = new OutlinePlanner({
      async generate() {
        return {
          text: JSON.stringify(validOutline),
          model: "test-model",
        };
      },
    });

    const result = await planner.plan({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.outline.sections).toHaveLength(1);
    expect(result.totalTargetWords).toBe(135);
  });

  it("rejects invalid JSON", async () => {
    const planner = new OutlinePlanner({
      async generate() {
        return {
          text: "not-json",
          model: "test-model",
        };
      },
    });

    await expect(
      planner.plan({
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      }),
    ).rejects.toThrow("invalid JSON");
  });

  it("rejects excessive word-budget deviation", async () => {
    const planner = new OutlinePlanner({
      async generate() {
        return {
          text: JSON.stringify({
            ...validOutline,
            sections: [
              {
                ...validOutline.sections[0],
                targetWords: 500,
              },
            ],
          }),
          model: "test-model",
        };
      },
    });

    await expect(
      planner.plan({
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      }),
    ).rejects.toThrow("word budget deviates");
  });

  it("rejects missing outline sections", async () => {
    const planner = new OutlinePlanner({
      async generate() {
        return {
          text: JSON.stringify({
            ...validOutline,
            sections: [],
          }),
          model: "test-model",
        };
      },
    });

    await expect(
      planner.plan({
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      }),
    ).rejects.toThrow();
  });
});
