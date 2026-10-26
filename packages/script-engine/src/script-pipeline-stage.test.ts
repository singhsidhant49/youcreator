import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import type {
  VideoJob,
} from "@youcreator/contracts";

import {
  PipelineRegistry,
  PipelineRunner,
} from "@youcreator/core";

import {
  createScriptPipelineStage,
} from "./script-pipeline-stage.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook:
    "Why do people delay important tasks?",
  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",
      narration:
        "People sometimes postpone difficult tasks " +
        "because avoiding them provides temporary relief.",
      estimatedDurationSeconds: 15,
    },
  ],
  outro:
    "Choose one manageable action and begin.",
};

function makeGenerator() {
  return {
    generate: vi.fn(async () => ({
      script,
      finalScript: script,

      llmUsage: {
        requests: 4,
        failedRequests: 0,
        reservedOutputTokens: 4096,
        reportedInputTokens: 150,
        reportedOutputTokens: 240,
      },

      promotion: {
        promoted: false,
        reason: "Promotion disabled",
      },
    })),
  };
}

function makeJob(
  id: string,
  title = "Why Humans Procrastinate",
): VideoJob {
  // The runner only requires id and config.
  // Replace with your full VideoJob fixture later
  // when moving these tests into job lifecycle tests.
  return {
    id,
    config: {
      title,
      mode: "B",
      durationSeconds: 60,
      resolution: "1920x1080",
      fps: 30,
    },
  } as unknown as VideoJob;
}

function makeRunner(
  generator: ReturnType<typeof makeGenerator>,
  generationKey = "deepseek:script-v1",
) {
  const registry = new PipelineRegistry();

  registry.register(
    createScriptPipelineStage(generator, {
      generationKey,
    }),
  );

  return new PipelineRunner(registry);
}

describe("Script pipeline integration", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-pipeline-"),
    );

    return root;
  }

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });
      root = undefined;
    }
  });

  it("executes and checkpoints script generation", async () => {
    const directory = await setup();
    const generator = makeGenerator();
    const runner = makeRunner(generator);

    const job = makeJob("job-first");

    const result = await runner.run(
      job,
      path.join(directory, job.id),
    );

    expect(result.status).toBe("completed");
    expect(result.stageRuns[0]?.status).toBe(
      "completed",
    );

    expect(generator.generate).toHaveBeenCalledOnce();

    expect(result.outputs.has("script")).toBe(true);
  });

  it("reuses a valid checkpoint without LLM calls", async () => {
    const directory = await setup();
    const generator = makeGenerator();
    const runner = makeRunner(generator);

    const job = makeJob("job-reuse");
    const jobDirectory = path.join(
      directory,
      job.id,
    );

    const first = await runner.run(
      job,
      jobDirectory,
    );

    const second = await runner.run(
      job,
      jobDirectory,
    );

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");

    expect(second.stageRuns[0]?.status).toBe(
      "skipped",
    );

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("recovers saved artifacts when checkpoint is missing", async () => {
    const directory = await setup();
    const generator = makeGenerator();
    const runner = makeRunner(generator);

    const job = makeJob("job-recover");
    const jobDirectory = path.join(
      directory,
      job.id,
    );

    await runner.run(job, jobDirectory);

    await rm(
      path.join(
        jobDirectory,
        "checkpoints",
        "script.json",
      ),
      { force: true },
    );

    const recovered = await runner.run(
      job,
      jobDirectory,
    );

    expect(recovered.status).toBe("completed");

    // Runner executes the adapter because the
    // checkpoint is missing, but the underlying
    // handler recovers existing artifacts.
    expect(
      recovered.stageRuns[0]?.status,
    ).toBe("completed");

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("fails safely if the job brief changes", async () => {
    const directory = await setup();
    const generator = makeGenerator();
    const runner = makeRunner(generator);

    const original = makeJob(
      "job-changed",
      "Why Humans Procrastinate",
    );

    const jobDirectory = path.join(
      directory,
      original.id,
    );

    await runner.run(original, jobDirectory);

    const changed = makeJob(
      "job-changed",
      "Why Humans Dream",
    );

    const second = await runner.run(
      changed,
      jobDirectory,
    );

    expect(second.status).toBe("failed");

    expect(second.stageRuns[0]?.error).toContain(
      "fingerprint mismatch",
    );

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("does not regenerate when persisted files are corrupt", async () => {
    const directory = await setup();
    const generator = makeGenerator();
    const runner = makeRunner(generator);

    const job = makeJob("job-corrupt");
    const jobDirectory = path.join(
      directory,
      job.id,
    );

    const first = await runner.run(
      job,
      jobDirectory,
    );

    expect(first.status).toBe("completed");

    await writeFile(
      path.join(
        jobDirectory,
        "script",
        "final-script.json",
      ),
      "{corrupt-json",
      "utf8",
    );

    const second = await runner.run(
      job,
      jobDirectory,
    );

    expect(second.status).toBe("failed");
    expect(second.stageRuns[0]?.status).toBe(
      "failed",
    );

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("blocks an underlength script from completing the pipeline", async () => {
    const directory = await setup();
    const generator = makeGenerator();

    const registry = new PipelineRegistry();

    registry.register(
      createScriptPipelineStage(generator, {
        generationKey: "readiness-test-v1",
        readiness: {
          enabled: true,
        },
      }),
    );

    const runner = new PipelineRunner(registry);
    const job = makeJob("job-too-short");

    const result = await runner.run(
      job,
      path.join(directory, job.id),
    );

    expect(result.status).toBe("failed");

    expect(result.stageRuns[0]?.error).toContain(
      "Final script readiness failed",
    );

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("reuses a readiness-approved script without regeneration", async () => {
    const directory = await setup();
    const generator = makeGenerator();

    const registry = new PipelineRegistry();

    registry.register(
      createScriptPipelineStage(generator, {
        generationKey: "readiness-test-v2",
        readiness: {
          enabled: true,
          policy: {
            // Permissive limits for this short mock fixture.
            minimumDurationRatio: 0.01,
            maximumDurationRatio: 10,
          },
        },
      }),
    );

    const runner = new PipelineRunner(registry);
    const job = makeJob("job-ready");

    const jobDirectory = path.join(
      directory,
      job.id,
    );

    const first = await runner.run(
      job,
      jobDirectory,
    );

    const second = await runner.run(
      job,
      jobDirectory,
    );

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");

    expect(second.stageRuns[0]?.status).toBe("skipped");

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("does not reuse artifacts with a different readiness policy", async () => {
    const directory = await setup();
    const generator = makeGenerator();

    const job = makeJob("job-policy-change");

    const jobDirectory = path.join(
      directory,
      job.id,
    );

    const firstRegistry = new PipelineRegistry();

    firstRegistry.register(
      createScriptPipelineStage(generator, {
        generationKey: "same-model",
        readiness: {
          enabled: true,
          policy: {
            minimumDurationRatio: 0.01,
            maximumDurationRatio: 10,
          },
        },
      }),
    );

    const firstRunner = new PipelineRunner(
      firstRegistry,
    );

    const first = await firstRunner.run(
      job,
      jobDirectory,
    );

    expect(first.status).toBe("completed");

    const secondRegistry = new PipelineRegistry();

    secondRegistry.register(
      createScriptPipelineStage(generator, {
        generationKey: "same-model",
        readiness: {
          enabled: true,
          policy: {
            minimumDurationRatio: 0.8,
            maximumDurationRatio: 1.2,
          },
        },
      }),
    );

    const secondRunner = new PipelineRunner(
      secondRegistry,
    );

    const second = await secondRunner.run(
      job,
      jobDirectory,
    );

    expect(second.status).toBe("failed");

    expect(second.stageRuns[0]?.error).toContain(
      "fingerprint mismatch",
    );

    // The saved artifacts must not trigger another
    // paid generation when configuration changes.
    expect(generator.generate).toHaveBeenCalledOnce();
  });
});
