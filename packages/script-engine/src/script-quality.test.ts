import { describe, expect, it } from "vitest";
import { analyzeScript } from "./script-quality.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook: "Why do we put off the tasks that matter most?",
  sections: [
    {
      id: "section-001",
      title: "The Psychology",
      narration: Array(80)
        .fill("Procrastination involves emotions and habits.")
        .join(" "),
      estimatedDurationSeconds: 60,
    },
  ],
  outro: "Understanding these habits can help us change.",
};

describe("Script Quality", () => {
  it("passes a script within the target word range", () => {
    const result = analyzeScript(script, 180, {
      minSectionWords: 10,
    });

    expect(result.passed).toBe(true);
    expect(result.totalWords).toBeGreaterThan(350);
  });

  it("detects scripts that are too short", () => {
    const result = analyzeScript(script, 600);

    expect(result.passed).toBe(false);

    expect(
      result.issues.some(
        (issue) => issue.code === "TOO_SHORT",
      ),
    ).toBe(true);
  });

  it("detects scripts that are too long", () => {
    const result = analyzeScript(script, 30);

    expect(result.passed).toBe(false);

    expect(
      result.issues.some(
        (issue) => issue.code === "TOO_LONG",
      ),
    ).toBe(true);
  });

  it("detects duplicate section IDs", () => {
    const result = analyzeScript(
      {
        ...script,
        sections: [
          script.sections[0],
          {
            ...script.sections[0],
            narration: "Different narration.",
          },
        ],
      },
      180,
    );

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "DUPLICATE_SECTION_ID",
      ),
    ).toBe(true);
  });

  it("detects repeated narration", () => {
    const result = analyzeScript(
      {
        ...script,
        sections: [
          script.sections[0],
          {
            ...script.sections[0],
            id: "section-002",
          },
        ],
      },
      360,
    );

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "REPEATED_NARRATION",
      ),
    ).toBe(true);
  });

  it("rejects invalid target duration", () => {
    expect(() => analyzeScript(script, 0)).toThrow(
      "Invalid target duration",
    );
  });
});
