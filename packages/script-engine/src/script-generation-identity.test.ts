import { describe, expect, it } from "vitest";

import {
  createScriptGenerationKey,
  type ScriptGenerationIdentityConfig,
} from "./script-generation-identity.js";

const config: ScriptGenerationIdentityConfig = {
  provider: "deepseek",
  model: "deepseek-flash",

  promptVersions: {
    outline: "v1",
    hook: "v1",
    section: "v1",
    outro: "v1",
    revision: "v1",
  },

  scriptEngineVersion: "m2-v1",

  editorial: {
    enabled: true,
    requireExample: true,
    minimumSectionWords: 35,
    revisionsEnabled: true,
    maxRevisionCalls: 2,
  },

  promotion: {
    enabled: false,
    maxWordDriftRatio: 0.2,
    maxDurationDriftSeconds: 15,
  },

  generation: {
    reviseSections: true,
    enforceQuality: true,
    wordsPerMinute: 135,
  },
};

describe("Script generation identity", () => {
  it("produces a deterministic key", () => {
    const first = createScriptGenerationKey(config);
    const second = createScriptGenerationKey({
      ...config,
    });

    expect(first).toBe(second);

    expect(first).toMatch(
      /^script-config-v1:[a-f0-9]{64}$/,
    );
  });

  it("changes when the model changes", () => {
    const first = createScriptGenerationKey(config);

    const second = createScriptGenerationKey({
      ...config,
      model: "another-model",
    });

    expect(first).not.toBe(second);
  });

  it("changes when prompt versions change", () => {
    const first = createScriptGenerationKey(config);

    const second = createScriptGenerationKey({
      ...config,
      promptVersions: {
        ...config.promptVersions,
        section: "v2",
      },
    });

    expect(first).not.toBe(second);
  });

  it("changes when editorial configuration changes", () => {
    const first = createScriptGenerationKey(config);

    const second = createScriptGenerationKey({
      ...config,
      editorial: {
        ...config.editorial,
        maxRevisionCalls: 3,
      },
    });

    expect(first).not.toBe(second);
  });

  it("changes when promotion policy changes", () => {
    const first = createScriptGenerationKey(config);

    const second = createScriptGenerationKey({
      ...config,
      promotion: {
        ...config.promotion,
        enabled: true,
      },
    });

    expect(first).not.toBe(second);
  });

  it("rejects incomplete configuration", () => {
    expect(() =>
      createScriptGenerationKey({
        ...config,
        model: "",
      }),
    ).toThrow();

    expect(() =>
      createScriptGenerationKey({
        ...config,
        generation: {
          ...config.generation,
          wordsPerMinute: 0,
        },
      }),
    ).toThrow();
  });
});
