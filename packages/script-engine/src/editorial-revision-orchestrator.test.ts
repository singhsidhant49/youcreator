import { describe, expect, it, vi } from "vitest";

import {
  EditorialRevisionOrchestrator,
} from "./editorial-revision-orchestrator.js";

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

const improvedHook =
  "You sit down to finish an important assignment, " +
  "but suddenly cleaning your room feels more urgent. " +
  "Why does this happen?";

const improvedOutro =
  "When you feel resistance, set a timer for two minutes " +
  "and begin the easiest part of your task before " +
  "deciding what to do next.";

function provider(responses: string[]) {
  return {
    generate: vi.fn(async () => ({
      text: JSON.stringify({
        narration: responses.shift() ?? "Unchanged",
      }),
      model: "test-model",
    })),
  };
}

describe("EditorialRevisionOrchestrator", () => {
  it("accepts targeted hook and outro improvements", async () => {
    const llm = provider([
      improvedHook,
      improvedOutro,
    ]);

    const orchestrator =
      new EditorialRevisionOrchestrator(llm);

    const result = await orchestrator.improve(script, {
      maxRevisionCalls: 2,
      minimumSectionWords: 0,
    });

    expect(result.revisionCalls).toBe(2);
    expect(result.acceptedRevisions).toBe(2);
    expect(result.rejectedRevisions).toBe(0);
    expect(result.script.hook).toBe(improvedHook);
    expect(result.script.outro).toBe(improvedOutro);
    expect(llm.generate).toHaveBeenCalledTimes(2);
  });

  it("respects the maximum revision budget", async () => {
    const llm = provider([
      improvedHook,
      improvedOutro,
    ]);

    const result =
      await new EditorialRevisionOrchestrator(
        llm,
      ).improve(script, {
        maxRevisionCalls: 1,
        minimumSectionWords: 35,
      });

    expect(result.revisionCalls).toBe(1);
    expect(llm.generate).toHaveBeenCalledOnce();
    expect(result.skippedIssues.length).toBeGreaterThan(0);
  });

  it("preserves original narration on rejection", async () => {
    const llm = provider(["Why delay?"]);

    const result =
      await new EditorialRevisionOrchestrator(
        llm,
      ).improve(script, {
        maxRevisionCalls: 1,
        minimumSectionWords: 0,
      });

    expect(result.acceptedRevisions).toBe(0);
    expect(result.rejectedRevisions).toBe(1);
    expect(result.script.hook).toBe(script.hook);
    expect(result.audit[0]?.accepted).toBe(false);
  });

  it("does not make calls when disabled", async () => {
    const llm = provider([]);

    const result =
      await new EditorialRevisionOrchestrator(
        llm,
      ).improve(script, {
        enabled: false,
      });

    expect(result.revisionCalls).toBe(0);
    expect(result.script).toEqual(script);
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("records provider failures without modifying the script", async () => {
    const generate = vi.fn(async () => {
      throw new Error("Provider unavailable");
    });

    const result =
      await new EditorialRevisionOrchestrator({
        generate,
      }).improve(script, {
        maxRevisionCalls: 1,
      });

    expect(result.revisionCalls).toBe(1);
    expect(result.rejectedRevisions).toBe(1);
    expect(result.script).toEqual(script);
    expect(result.audit[0]?.reason).toContain(
      "Provider unavailable",
    );
  });

  it("rejects invalid revision budgets", async () => {
    const llm = provider([]);

    await expect(
      new EditorialRevisionOrchestrator(
        llm,
      ).improve(script, {
        maxRevisionCalls: -1,
      }),
    ).rejects.toThrow(
      "Invalid maximum editorial revision calls",
    );

    expect(llm.generate).not.toHaveBeenCalled();
  });
});
