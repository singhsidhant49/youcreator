import { describe, expect, it, vi } from "vitest";

import { NarrationReviser } from "./narration-reviser.js";

const request = {
  narration: "A very short narration.",
  targetWords: 100,
  language: "en",
  tone: "documentary",
  context: "A video about procrastination.",
};

const goodNarration = Array(100).fill("word").join(" ");

describe("NarrationReviser", () => {
  it("expands narration toward the target", async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        narration: goodNarration,
      }),
      model: "test-model",
    }));

    const reviser = new NarrationReviser({ generate });

    const result = await reviser.revise(request);

    expect(result.passed).toBe(true);
    expect(result.actualWords).toBe(100);
    expect(result.attempts).toBe(1);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("skips revision when already within tolerance", async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        narration: goodNarration,
      }),
      model: "test-model",
    }));

    const reviser = new NarrationReviser({ generate });

    const result = await reviser.revise({
      ...request,
      narration: goodNarration,
    });

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("stops after the configured attempt limit", async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        narration: "Still too short.",
      }),
      model: "test-model",
    }));

    const reviser = new NarrationReviser(
      { generate },
      { maxAttempts: 2 },
    );

    const result = await reviser.revise(request);

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid target word counts", async () => {
    const reviser = new NarrationReviser({
      async generate() {
        return {
          text: "{}",
          model: "test-model",
        };
      },
    });

    await expect(
      reviser.revise({
        ...request,
        targetWords: 0,
      }),
    ).rejects.toThrow("Invalid target word count");
  });

  it("rejects invalid JSON responses", async () => {
    const reviser = new NarrationReviser({
      async generate() {
        return {
          text: "not-json",
          model: "test-model",
        };
      },
    });

    await expect(
      reviser.revise(request),
    ).rejects.toThrow("invalid JSON");
  });
});
