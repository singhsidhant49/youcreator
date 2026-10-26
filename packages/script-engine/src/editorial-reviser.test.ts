import { describe, expect, it, vi } from "vitest";

import { EditorialReviser } from "./editorial-reviser.js";
import { evaluateEditorialQuality } from "./editorial-quality.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook: "Why procrastinate?",
  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",
      narration:
        "People sometimes delay difficult tasks because " +
        "avoiding them provides temporary emotional relief.",
      estimatedDurationSeconds: 15,
    },
  ],
  outro: "Start with one small step.",
};

function getIssue(
  code: "WEAK_HOOK" | "GENERIC_OUTRO",
) {
  const issue = evaluateEditorialQuality(
    script,
  ).issues.find((item) => item.code === code);

  if (!issue) {
    throw new Error(`Missing test issue: ${code}`);
  }

  return issue;
}

describe("EditorialReviser", () => {
  it("improves a weak hook independently", async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        narration:
          "You sit down to work, but suddenly every " +
          "other task seems more important. Why does " +
          "your mind keep doing this?",
      }),
      model: "test-model",
    }));

    const reviser = new EditorialReviser({ generate });

    const result = await reviser.revise(
      script,
      getIssue("WEAK_HOOK"),
    );

    expect(result.accepted).toBe(true);
    expect(result.script.hook).toContain(
      "You sit down to work",
    );

    expect(result.script.sections).toEqual(
      script.sections,
    );

    expect(result.script.outro).toBe(script.outro);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("improves a generic outro", async () => {
    const reviser = new EditorialReviser({
      async generate() {
        return {
          text: JSON.stringify({
            narration:
              "When you feel resistance, choose one task " +
              "and work on it for two minutes before " +
              "deciding whether to continue.",
          }),
          model: "test-model",
        };
      },
    });

    const result = await reviser.revise(
      script,
      getIssue("GENERIC_OUTRO"),
    );

    expect(result.accepted).toBe(true);
    expect(result.script.outro).toContain(
      "two minutes",
    );
    expect(result.script.hook).toBe(script.hook);
  });

  it("preserves original narration if issue remains", async () => {
    const reviser = new EditorialReviser({
      async generate() {
        return {
          text: JSON.stringify({
            narration: "Why delay?",
          }),
          model: "test-model",
        };
      },
    });

    const result = await reviser.revise(
      script,
      getIssue("WEAK_HOOK"),
    );

    expect(result.accepted).toBe(false);
    expect(result.script.hook).toBe(script.hook);
    expect(result.proposedNarration).toBe("Why delay?");
  });

  it("rejects stale editorial issues", async () => {
    const generate = vi.fn();

    const reviser = new EditorialReviser({
      generate,
    });

    await expect(
      reviser.revise(script, {
        code: "GENERIC_OUTRO",
        severity: "warning",
        message: "Problem",
        location: "hook",
        suggestion: "Improve",
      }),
    ).rejects.toThrow(
      "Editorial issue is no longer present",
    );

    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON responses", async () => {
    const reviser = new EditorialReviser({
      async generate() {
        return {
          text: "invalid-json",
          model: "test-model",
        };
      },
    });

    await expect(
      reviser.revise(script, getIssue("WEAK_HOOK")),
    ).rejects.toThrow("invalid JSON");
  });
});
