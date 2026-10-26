import { describe, expect, it } from "vitest";

import {
  evaluateEditorialQuality,
} from "./editorial-quality.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook:
    "You sit down to work, but suddenly cleaning your room seems more important. Why does this happen?",
  sections: [
    {
      id: "section-001",
      title: "Understanding Procrastination",
      narration:
        "Imagine having an important assignment due tomorrow. " +
        "Instead of starting, you check your phone. " +
        "The distraction provides immediate relief from the discomfort " +
        "associated with beginning a difficult task. " +
        "This is one reason procrastination can become a habit.",
      estimatedDurationSeconds: 20,
    },
  ],
  outro:
    "Next time you feel that resistance, try working for just two minutes before deciding whether to continue.",
};

describe("Editorial Quality Evaluator", () => {
  it("accepts a script without obvious issues", () => {
    const result = evaluateEditorialQuality(script, {
      requireExample: true,
    });

    expect(result.issues).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it("detects weak hooks", () => {
    const result = evaluateEditorialQuality({
      ...script,
      hook: "Why procrastinate?",
    });

    expect(
      result.issues.some(
        (issue) => issue.code === "WEAK_HOOK",
      ),
    ).toBe(true);
  });

  it("detects generic conclusions", () => {
    const result = evaluateEditorialQuality({
      ...script,
      outro: "Start with one small step.",
    });

    expect(
      result.issues.some(
        (issue) => issue.code === "GENERIC_OUTRO",
      ),
    ).toBe(true);
  });

  it("flags missing explicit examples", () => {
    const result = evaluateEditorialQuality(
      {
        ...script,
        hook: "Procrastination affects our decisions in daily life.",
        sections: [
          {
            ...script.sections[0],
            narration:
              "Procrastination involves delaying tasks because " +
              "short-term relief can feel more rewarding.",
          },
        ],
      },
      { requireExample: true },
    );

    expect(
      result.issues.some(
        (issue) => issue.code === "MISSING_EXAMPLE",
      ),
    ).toBe(true);
  });

  it("flags potentially overconfident claims", () => {
    const result = evaluateEditorialQuality({
      ...script,
      sections: [
        {
          ...script.sections[0],
          narration:
            "The brain always avoids difficult tasks.",
        },
      ],
    });

    expect(
      result.issues.some(
        (issue) => issue.code === "POTENTIAL_OVERCLAIM",
      ),
    ).toBe(true);
  });

  it("does not require examples when disabled", () => {
    const result = evaluateEditorialQuality(script, {
      requireExample: false,
    });

    expect(
      result.issues.some(
        (issue) => issue.code === "MISSING_EXAMPLE",
      ),
    ).toBe(false);
  });
});
