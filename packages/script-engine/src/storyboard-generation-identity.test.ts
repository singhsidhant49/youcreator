import { describe, expect, it } from "vitest";

import {
  createStoryboardGenerationKey,
  type StoryboardGenerationConfig,
} from "./storyboard-generation-identity.js";

export const config: StoryboardGenerationConfig = {
  provider: "deepseek",
  model: "test-model",
  promptVersion: "v1",
  plannerVersion: "m3-v1",

  segmentation: {
    algorithmVersion: "sentence-aware-v1",
    profile: "documentary",
    maxWordsPerShot: 12,
    wordsPerMinute: 135,
  },

  llm: {
    maxTokensPerRequest: 4096,
    temperature: 0.2,
    jsonMode: true,
  },
};

describe("Storyboard generation identity", () => {
  it("produces a stable canonical key", () => {
    const first = createStoryboardGenerationKey(config);
    const second = createStoryboardGenerationKey({
      ...config,
    });

    expect(first).toBe(second);
    expect(first).toMatch(
      /^storyboard-config-v1:[a-f0-9]{64}$/,
    );
  });

  it("invalidates identity when the model changes", () => {
    expect(
      createStoryboardGenerationKey(config),
    ).not.toBe(
      createStoryboardGenerationKey({
        ...config,
        model: "new-model",
      }),
    );
  });

  it("invalidates identity when prompts change", () => {
    expect(
      createStoryboardGenerationKey(config),
    ).not.toBe(
      createStoryboardGenerationKey({
        ...config,
        promptVersion: "v2",
      }),
    );
  });

  it("invalidates identity when segmentation changes", () => {
    expect(
      createStoryboardGenerationKey(config),
    ).not.toBe(
      createStoryboardGenerationKey({
        ...config,
        segmentation: {
          ...config.segmentation,
          maxWordsPerShot: 20,
        },
      }),
    );
  });

  it("invalidates identity when LLM settings change", () => {
    expect(
      createStoryboardGenerationKey(config),
    ).not.toBe(
      createStoryboardGenerationKey({
        ...config,
        llm: {
          ...config.llm,
          temperature: 0.5,
        },
      }),
    );
  });

  it("rejects invalid configuration", () => {
    expect(() =>
      createStoryboardGenerationKey({
        ...config,
        segmentation: {
          ...config.segmentation,
          wordsPerMinute: 0,
        },
      }),
    ).toThrow();
  });
});
