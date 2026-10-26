import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createScriptPipelineStage,
} from "./script-pipeline-stage.js";

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

function makeGenerator() {
  return {
    generate: vi.fn(async () => {
      throw new Error(
        "Generation must not run during registration tests",
      );
    }),
  };
}

describe("Script pipeline configuration identity", () => {
  it("registers a stage using a canonical configuration key", () => {
    const stage = createScriptPipelineStage(
      makeGenerator(),
      {
        generationConfig: config,
      },
    );

    expect(stage.id).toBe("script");

    expect(stage.version).toContain(
      createScriptGenerationKey(config),
    );
  });

  it("changes stage version when model configuration changes", () => {
    const generator = makeGenerator();

    const first = createScriptPipelineStage(generator, {
      generationConfig: config,
    });

    const second = createScriptPipelineStage(generator, {
      generationConfig: {
        ...config,
        model: "another-model",
      },
    });

    expect(first.version).not.toBe(second.version);
  });

  it("changes stage version when editorial settings change", () => {
    const generator = makeGenerator();

    const first = createScriptPipelineStage(generator, {
      generationConfig: config,
    });

    const second = createScriptPipelineStage(generator, {
      generationConfig: {
        ...config,
        editorial: {
          ...config.editorial,
          maxRevisionCalls: 4,
        },
      },
    });

    expect(first.version).not.toBe(second.version);
  });

  it("keeps legacy generation-key registration working", () => {
    const stage = createScriptPipelineStage(
      makeGenerator(),
      {
        generationKey: "legacy-test-key",
      },
    );

    expect(stage.version).toContain(
      "legacy-test-key",
    );
  });

  it("rejects invalid canonical configuration at registration", () => {
    expect(() =>
      createScriptPipelineStage(
        makeGenerator(),
        {
          generationConfig: {
            ...config,
            model: "",
          },
        },
      ),
    ).toThrow();
  });
});
