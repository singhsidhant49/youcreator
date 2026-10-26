import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  ScriptGenerationStage,
} from "./script-generation-stage.js";

import {
  validateScriptStageOutput,
} from "./script-stage-output.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook: "Why do humans procrastinate?",
  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",
      narration:
        "Avoiding a difficult task can provide " +
        "temporary relief from uncomfortable feelings.",
      estimatedDurationSeconds: 12,
    },
  ],
  outro: "Begin with one manageable task.",
};

describe("Script stage checkpoint validation", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });
      root = undefined;
    }
  });

  async function makeStageOutput() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-checkpoint-"),
    );

    const stage = new ScriptGenerationStage({
      async generate() {
        return {
          script,
          finalScript: script,
          llmUsage: {
            requests: 4,
            failedRequests: 0,
            reservedOutputTokens: 4096,
            reportedInputTokens: 100,
            reportedOutputTokens: 200,
          },
          promotion: {
            promoted: false,
            reason: "Promotion disabled",
          },
        };
      },
    });

    return stage.execute({
      jobId: "checkpoint-test",
      jobsRoot: root,
      generationKey: "model:prompt-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    });
  }

  it("accepts valid persisted stage output", async () => {
    const output = await makeStageOutput();

    const validated =
      await validateScriptStageOutput(output);

    expect(validated).toEqual(output);
  });

  it("rejects missing or corrupt script files", async () => {
    const output = await makeStageOutput();

    await writeFile(
      output.finalScriptPath,
      "{not-valid-json",
      "utf8",
    );

    await expect(
      validateScriptStageOutput(output),
    ).rejects.toThrow();
  });

  it("rejects manipulated checkpoint metadata", async () => {
    const output = await makeStageOutput();

    await expect(
      validateScriptStageOutput({
        ...output,
        llmRequests: 999,
      }),
    ).rejects.toThrow(
      "checkpoint metadata does not match",
    );
  });

  it("rejects artifact path substitution", async () => {
    const output = await makeStageOutput();

    await expect(
      validateScriptStageOutput({
        ...output,
        finalScriptPath: "/tmp/another-script.json",
      }),
    ).rejects.toThrow(
      "inconsistent artifact paths",
    );
  });
});
