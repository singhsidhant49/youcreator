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

import type { VideoJob } from "@youcreator/contracts";
import type { PipelineContext } from "@youcreator/core";

import {
  ScriptGenerationStage,
} from "./script-generation-stage.js";

import {
  loadVerifiedStoryboardSource,
} from "./verified-storyboard-source.js";

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

const promotedFinalScript = {
  ...script,
  outro: "Start with a single two-minute action today.",
};

describe("Verified storyboard source binding", () => {
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

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-storyboard-source-",
      ),
    );

    const jobId = "job-001";
    const jobDirectory = path.join(root, jobId);

    const job: VideoJob = {
      id: jobId,
      status: "running",
      config: {
        title: "Why Humans Procrastinate",
        mode: "B",
        durationSeconds: 60,
        resolution: "1920x1080",
        fps: 30,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const stage = new ScriptGenerationStage({
      async generate() {
        return {
          script,
          finalScript: promotedFinalScript,
          llmUsage: {
            requests: 4,
            failedRequests: 0,
            reservedOutputTokens: 4096,
            reportedInputTokens: 100,
            reportedOutputTokens: 200,
          },
          promotion: {
            promoted: true,
            reason: "Passed all editorial gates",
          },
        };
      },
    });

    const stageOutput = await stage.execute({
      jobId,
      jobsRoot: root,
      generationKey: "model:prompt-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    });

    return {
      root,
      job,
      jobDirectory,
      stageOutput,
      finalScript: promotedFinalScript,
    };
  }

  it("returns the final promoted script for valid M2 checkpoint and verified artifacts", async () => {
    const env = await setup();

    const context: PipelineContext = {
      job: env.job,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        ["script", env.stageOutput],
      ]),
    };

    const result =
      await loadVerifiedStoryboardSource(context);

    expect(result).toEqual(env.finalScript);
  });

  it("fails when script-stage output is missing", async () => {
    const env = await setup();

    const context: PipelineContext = {
      job: env.job,
      jobDirectory: env.jobDirectory,
      outputs: new Map(),
    };

    await expect(
      loadVerifiedStoryboardSource(context),
    ).rejects.toThrow("Missing script stage output");
  });

  it("fails on a mismatched generation fingerprint", async () => {
    const env = await setup();

    const context: PipelineContext = {
      job: env.job,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        [
          "script",
          {
            ...env.stageOutput,
            generationFingerprint: "0".repeat(64),
          },
        ],
      ]),
    };

    await expect(
      loadVerifiedStoryboardSource(context),
    ).rejects.toThrow(
      "M2 script generation fingerprint mismatch",
    );
  });

  it("fails when M2 script artifacts are corrupted", async () => {
    const env = await setup();

    await writeFile(
      env.stageOutput.finalScriptPath,
      JSON.stringify({
        ...env.finalScript,
        title: "Tampered Title",
      }),
      "utf8",
    );

    const context: PipelineContext = {
      job: env.job,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        ["script", env.stageOutput],
      ]),
    };

    await expect(
      loadVerifiedStoryboardSource(context),
    ).rejects.toThrow();
  });

  it("fails when script artifact belongs to another job", async () => {
    const env = await setup();

    const context: PipelineContext = {
      job: env.job,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        [
          "script",
          {
            ...env.stageOutput,
            jobId: "job-999-different",
          },
        ],
      ]),
    };

    await expect(
      loadVerifiedStoryboardSource(context),
    ).rejects.toThrow(
      "M2 script artifact job ID mismatch",
    );
  });

  it("fails when stage output points outside expected job directory", async () => {
    const env = await setup();

    const foreignDir = path.join(
      env.root,
      "other-job",
      "script",
    );

    const context: PipelineContext = {
      job: env.job,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        [
          "script",
          {
            ...env.stageOutput,
            artifactDirectory: foreignDir,
            originalScriptPath: path.join(
              foreignDir,
              "original-script.json",
            ),
            finalScriptPath: path.join(
              foreignDir,
              "final-script.json",
            ),
            reportPath: path.join(
              foreignDir,
              "generation-report.json",
            ),
          },
        ],
      ]),
    };

    await expect(
      loadVerifiedStoryboardSource(context),
    ).rejects.toThrow(
      "Script stage output points outside expected job directory",
    );
  });
});
