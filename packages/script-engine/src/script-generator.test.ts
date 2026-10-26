import { describe, expect, it, vi } from "vitest";

import { ScriptGenerator } from "./script-generator.js";

const mockScript = {
  version: 1,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook: "Why do we delay important tasks?",
  sections: [
    {
      id: "section-001",
      title: "The Psychology",
      narration:
        "Procrastination is often connected to emotional regulation.",
      estimatedDurationSeconds: 45,
    },
  ],
  outro: "Understanding the cause helps us change.",
};

describe("ScriptGenerator", () => {
  it("generates and validates a script", async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify(mockScript),
      model: "test-model",
      usage: {
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
      },
    }));

    const generator = new ScriptGenerator({ generate });

    const result = await generator.generate({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.script.title).toBe(
      "Why Humans Procrastinate",
    );

    expect(result.script.sections).toHaveLength(1);
    expect(result.estimatedWords).toBeGreaterThan(0);
    expect(result.usage?.totalTokens).toBe(300);

    expect(generate).toHaveBeenCalledOnce();
  });

  it("rejects invalid script output", async () => {
    const generator = new ScriptGenerator({
      async generate() {
        return {
          text: JSON.stringify({
            title: "Invalid script",
            sections: [],
          }),
          model: "test-model",
        };
      },
    });

    await expect(
      generator.generate({
        topic: "Test Video Topic",
        durationSeconds: 60,
      }),
    ).rejects.toThrow();
  });
});
