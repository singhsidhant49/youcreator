import { describe, expect, it } from "vitest";

import {
  evaluateFinalScriptReadiness,
} from "./final-script-readiness.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook:
    "You sit down to finish an important task, " +
    "but suddenly everything else seems more interesting.",
  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",
      narration:
        "Imagine opening your laptop to begin a difficult " +
        "assignment. You immediately feel uncomfortable. " +
        "Checking your phone gives you a moment of relief. " +
        "That relief can reinforce the habit of delaying work. " +
        "The task itself has not disappeared, but avoiding " +
        "it temporarily makes you feel better.",
      estimatedDurationSeconds: 20,
    },
  ],
  outro:
    "Next time this happens, set a timer for " +
    "two minutes and begin the easiest part " +
    "of the task.",
};

describe("Final script readiness", () => {
  it("accepts a script within duration bounds", () => {
    const result = evaluateFinalScriptReadiness(
      script,
      {
        targetDurationSeconds: 35,
      },
    );

    expect(result.ready).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.wordCount).toBeGreaterThan(0);
  });

  it("rejects a script that is too short", () => {
    const result = evaluateFinalScriptReadiness(
      script,
      {
        targetDurationSeconds: 180,
      },
    );

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      "Final script is shorter than allowed duration",
    );
  });

  it("rejects a script that is too long", () => {
    const result = evaluateFinalScriptReadiness(
      script,
      {
        targetDurationSeconds: 10,
      },
    );

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      "Final script exceeds allowed duration",
    );
  });

  it("rejects invalid duration configuration", () => {
    expect(() =>
      evaluateFinalScriptReadiness(script, {
        targetDurationSeconds: 0,
      }),
    ).toThrow(
      "Invalid final script readiness configuration",
    );
  });

  it("reports editorial warnings without blocking by default", () => {
    const result = evaluateFinalScriptReadiness(
      {
        ...script,
        outro: "Start with one small step.",
      },
      {
        targetDurationSeconds: 35,
      },
    );

    expect(
      result.warnings.some(
        (warning) => warning.includes("GENERIC_OUTRO"),
      ),
    ).toBe(true);

    expect(result.ready).toBe(true);
  });

  it("can enforce editorial findings as blockers", () => {
    const result = evaluateFinalScriptReadiness(
      {
        ...script,
        outro: "Start with one small step.",
      },
      {
        targetDurationSeconds: 35,
        requireEditorialIssueFree: true,
      },
    );

    expect(result.ready).toBe(false);
    expect(
      result.blockers.some(
        (blocker) => blocker.includes("GENERIC_OUTRO"),
      ),
    ).toBe(true);
  });
});
