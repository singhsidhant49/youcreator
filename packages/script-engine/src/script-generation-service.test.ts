import { describe, expect, it, vi } from "vitest";

import { ScriptGenerationService } from "./script-generation-service.js";
import { LLMBudgetExceededError } from "@youcreator/llm";

const outline = {
  version: 1,
  title: "Why Humans Procrastinate",
  centralIdea: "Procrastination involves emotional regulation.",
  hookPlan: "Open with a relatable question.",
  hookTargetWords: 20,
  sections: [
    {
      id: "section-001",
      title: "Understanding Procrastination",
      objective: "Explain why we delay tasks.",
      keyPoints: ["Emotions", "Short-term rewards"],
      targetWords: 100,
    },
  ],
  outroPlan: "Conclude with a practical takeaway.",
  outroTargetWords: 15,
};

const brief = {
  topic: "Why Humans Procrastinate",
  durationSeconds: 60,
};

function makeProvider() {
  const responses = [
    outline,
    { narration: "Why do we delay important tasks?" },
    {
      narration:
        "Procrastination is often related to emotional avoidance.",
    },
    { narration: "Understanding this helps us change." },
  ];

  return {
    generate: vi.fn(async () => ({
      text: JSON.stringify(responses.shift()),
      model: "test-model",
      usage: {
        inputTokens: 50,
        outputTokens: 30,
        totalTokens: 80,
      },
    })),
  };
}

function makeEditorialProvider() {
  const responses = [
    outline,

    { narration: "Why procrastinate?" },

    {
      narration:
        "Procrastination can involve avoiding " +
        "unpleasant feelings about difficult tasks.",
    },

    {
      narration:
        "When you feel resistance, try working " +
        "for two minutes before deciding whether " +
        "to continue.",
    },

    // Fifth response: targeted hook revision.
    {
      narration:
        "You sit down to finish an important " +
        "assignment, but suddenly cleaning your " +
        "room feels more urgent. Why does this happen?",
    },
  ];

  return {
    generate: vi.fn(async () => {
      const next = responses.shift();

      if (!next) {
        throw new Error(
          "Unexpected additional LLM request",
        );
      }

      return {
        text: JSON.stringify(next),
        model: "test-model",
        usage: {
          inputTokens: 50,
          outputTokens: 30,
          totalTokens: 80,
        },
      };
    }),
  };
}

describe("ScriptGenerationService", () => {
  it("shares one budget across all writing operations", async () => {
    const provider = makeProvider();

    const service = new ScriptGenerationService(provider, {
      budget: {
        maxRequests: 4,
        maxOutputTokens: 12000,
      },
      assembler: {
        reviseSections: false,
        enforceQuality: false,
      },
    });

    const result = await service.generate(brief);

    expect(result.script.sections).toHaveLength(1);
    expect(result.llmUsage.requests).toBe(4);
    expect(result.llmUsage.reportedInputTokens).toBe(200);
    expect(result.llmUsage.reportedOutputTokens).toBe(120);
    expect(provider.generate).toHaveBeenCalledTimes(4);
  });

  it("stops before exceeding the request budget", async () => {
    const provider = makeProvider();

    const service = new ScriptGenerationService(provider, {
      budget: {
        maxRequests: 2,
        maxOutputTokens: 12000,
      },
    });

    await expect(
      service.generate(brief),
    ).rejects.toBeInstanceOf(
      LLMBudgetExceededError,
    );

    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(service.getUsage().requests).toBe(2);
  });

  it("enforces the aggregate output-token reservation budget", async () => {
    const provider = makeProvider();

    const service = new ScriptGenerationService(provider, {
      budget: {
        maxRequests: 10,
        maxOutputTokens: 4096,
      },
    });

    await expect(
      service.generate(brief),
    ).rejects.toThrow("output token budget");

    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("preserves script quality reports", async () => {
    const service = new ScriptGenerationService(
      makeProvider(),
      {
        budget: {
          maxRequests: 4,
          maxOutputTokens: 12000,
        },
      },
    );

    const result = await service.generate(brief);

    expect(result.quality).toBeDefined();
    expect(result.quality.passed).toBe(false);
    expect(result.quality.totalWords).toBe(
      result.actualWords,
    );
  });

  it("shares one budget across generation and editorial revision", async () => {
    const provider = makeEditorialProvider();

    const service = new ScriptGenerationService(
      provider,
      {
        budget: {
          maxRequests: 5,
          maxOutputTokens: 20000,
        },

        assembler: {
          reviseSections: false,
          enforceQuality: false,
        },

        editorialRevisions: {
          enabled: true,
          maxRevisionCalls: 1,
          minimumSectionWords: 0,
        },
      },
    );

    const result = await service.generate({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(provider.generate).toHaveBeenCalledTimes(5);

    expect(result.llmUsage.requests).toBe(5);

    expect(
      result.editorialRevision?.revisionCalls,
    ).toBe(1);

    expect(
      result.editorialRevision?.acceptedRevisions,
    ).toBe(1);

    // Original output is preserved.
    expect(result.script.hook).toBe(
      "Why procrastinate?",
    );

    // Revised output remains a separate candidate.
    expect(
      result.editorialRevision?.script.hook,
    ).toContain(
      "You sit down to finish",
    );
  });

  it("does not revise narration when editorial revisions are disabled", async () => {
    const provider = makeEditorialProvider();

    const service = new ScriptGenerationService(
      provider,
      {
        budget: {
          maxRequests: 5,
          maxOutputTokens: 20000,
        },

        assembler: {
          reviseSections: false,
          enforceQuality: false,
        },

        editorialRevisions: {
          enabled: false,
        },
      },
    );

    const result = await service.generate({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(provider.generate).toHaveBeenCalledTimes(4);

    expect(result.llmUsage.requests).toBe(4);

    expect(result.editorialRevision).toBeUndefined();
  });

  it("does not exceed the shared budget when a revision is blocked", async () => {
    const provider = makeEditorialProvider();

    const service = new ScriptGenerationService(
      provider,
      {
        budget: {
          maxRequests: 4,
          maxOutputTokens: 20000,
        },

        assembler: {
          reviseSections: false,
          enforceQuality: false,
        },

        editorialRevisions: {
          enabled: true,
          maxRevisionCalls: 1,
          minimumSectionWords: 0,
        },
      },
    );

    const result = await service.generate({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    // The initial script uses all four allowed calls.
    // The editorial orchestrator catches and audits
    // the rejected budget-exceeded revision.
    expect(provider.generate).toHaveBeenCalledTimes(4);

    expect(result.llmUsage.requests).toBe(4);

    expect(
      result.editorialRevision?.rejectedRevisions,
    ).toBe(1);

    expect(
      result.editorialRevision?.audit[0]?.reason,
    ).toContain("budget exhausted");

    expect(
      result.editorialRevision?.script.hook,
    ).toBe("Why procrastinate?");
  });

  it("promotes an eligible candidate when explicitly enabled", async () => {
    const provider = makeEditorialProvider();

    const service = new ScriptGenerationService(provider, {
      budget: {
        maxRequests: 5,
        maxOutputTokens: 20000,
      },
      assembler: {
        reviseSections: false,
        enforceQuality: false,
      },
      editorialRevisions: {
        enabled: true,
        maxRevisionCalls: 1,
        minimumSectionWords: 0,
      },
      promotion: {
        enabled: true,
        policy: {
          maxWordDriftRatio: 1,
          maxDurationDriftSeconds: 60,
          editorial: {
            minimumSectionWords: 0,
          },
        },
      },
    });

    const result = await service.generate({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.promotion.promoted).toBe(true);

    expect(result.script.hook).toBe("Why procrastinate?");

    expect(result.finalScript.hook).toContain(
      "You sit down to finish",
    );

    expect(result.finalMetrics.words).toBeGreaterThan(
      result.actualWords,
    );

    expect(result.llmUsage.requests).toBe(5);
  });

  it("preserves the original when promotion is disabled", async () => {
    const service = new ScriptGenerationService(
      makeEditorialProvider(),
      {
        budget: {
          maxRequests: 5,
          maxOutputTokens: 20000,
        },
        assembler: {
          reviseSections: false,
          enforceQuality: false,
        },
        editorialRevisions: {
          enabled: true,
          maxRevisionCalls: 1,
          minimumSectionWords: 0,
        },
      },
    );

    const result = await service.generate({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.promotion.promoted).toBe(false);
    expect(result.finalScript).toEqual(result.script);

    // Editorial work is still available for review.
    expect(result.editorialRevision).toBeDefined();
  });

  it("rejects an editorial candidate that exceeds drift policy", async () => {
    const service = new ScriptGenerationService(
      makeEditorialProvider(),
      {
        budget: {
          maxRequests: 5,
          maxOutputTokens: 20000,
        },
        assembler: {
          reviseSections: false,
          enforceQuality: false,
        },
        editorialRevisions: {
          enabled: true,
          maxRevisionCalls: 1,
          minimumSectionWords: 0,
        },
        promotion: {
          enabled: true,
          policy: {
            maxWordDriftRatio: 0,
            maxDurationDriftSeconds: 60,
            editorial: {
              minimumSectionWords: 0,
            },
          },
        },
      },
    );

    const result = await service.generate({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.promotion.promoted).toBe(false);
    expect(result.promotion.reason).toContain(
      "word drift",
    );
    expect(result.finalScript).toEqual(result.script);
  });
});
