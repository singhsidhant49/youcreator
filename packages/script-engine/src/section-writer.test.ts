import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "@youcreator/llm";

import { SectionWriter } from "./section-writer.js";

const section = {
  id: "section-001",
  title: "Why We Procrastinate",
  objective: "Explain emotional avoidance.",
  keyPoints: [
    "Emotional regulation",
    "Short-term rewards",
  ],
  targetWords: 100,
};

const context = {
  videoTitle: "Why Humans Procrastinate",
  centralIdea: "Procrastination is linked to emotions.",
  language: "en",
  tone: "documentary",
  audience: "general",
};

describe("SectionWriter", () => {
  it("generates narration for a section", async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        narration:
          "People often procrastinate because difficult tasks create uncomfortable emotions.",
      }),
      model: "test-model",
    }));

    const writer = new SectionWriter({ generate });

    const result = await writer.write(section, context);

    expect(result.id).toBe("section-001");
    expect(result.narration).toContain("procrastinate");
    expect(result.actualWords).toBeGreaterThan(0);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("includes surrounding context in the prompt", async () => {
    const generate = vi.fn(
      async (messages: LLMMessage[]) => ({
        text: JSON.stringify({
          narration: "Our brains favor immediate rewards.",
        }),
        model: "test-model",
      }),
    );

    const writer = new SectionWriter({ generate });

    await writer.write(section, {
      ...context,
      previousNarration: "We have explored emotional avoidance.",
      nextSectionTitle: "How to Change the Habit",
    });

    const messages = generate.mock.calls[0]![0];

    const prompt = messages.find(
      (message) => message.role === "user",
    )?.content;

    expect(prompt).toContain(
      "We have explored emotional avoidance.",
    );

    expect(prompt).toContain(
      "How to Change the Habit",
    );
  });

  it("rejects invalid narration JSON", async () => {
    const writer = new SectionWriter({
      async generate() {
        return {
          text: "invalid-json",
          model: "test-model",
        };
      },
    });

    await expect(
      writer.write(section, context),
    ).rejects.toThrow("invalid JSON");
  });

  it("rejects empty narration", async () => {
    const writer = new SectionWriter({
      async generate() {
        return {
          text: JSON.stringify({
            narration: "",
          }),
          model: "test-model",
        };
      },
    });

    await expect(
      writer.write(section, context),
    ).rejects.toThrow();
  });
});
