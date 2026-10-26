import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  JobStore,
  JobExecutor,
  PipelineRegistry,
  PipelineRunner,
} from "@youcreator/core";

import {
  createScriptPipelineStage,
} from "./script-pipeline-stage.js";

// ------------------------------------------
// Test fixtures
// ------------------------------------------

const script = {
  version: 1 as const,

  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",

  hook:
    "You sit down to work, but suddenly " +
    "everything else feels more important.",

  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",

      narration:
        "People sometimes delay difficult tasks " +
        "because avoiding them provides temporary " +
        "emotional relief. This relief can reinforce " +
        "the habit of procrastination.",

      estimatedDurationSeconds: 12,
    },
  ],

  outro:
    "Next time this happens, set a timer for " +
    "two minutes and begin the easiest part.",
};

function createGenerator() {
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

// ------------------------------------------
// Environment setup
// ------------------------------------------

async function createEnvironment() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "youcreator-lifecycle-"),
  );

  const jobs = new JobStore(
    path.join(root, "jobs"),
  );

  const outputDirectory = path.join(
    root,
    "output",
  );

  const job = await jobs.create({
    title: "Why Humans Procrastinate",
    mode: "B",
    durationSeconds: 60,
    resolution: "1920x1080",
    fps: 30,
  });

  const registry = new PipelineRegistry();

  const generator = createGenerator();

  registry.register(
    createScriptPipelineStage(generator, {
      generationKey: "test-deepseek:prompts-v1",

      readiness: {
        enabled: true,

        // The mock script is deliberately short.
        // Use permissive bounds for lifecycle testing.
        policy: {
          minimumDurationRatio: 0.01,
          maximumDurationRatio: 10,
        },
      },
    }),
  );

  const runner = new PipelineRunner(registry);

  const executor = new JobExecutor(
    jobs,
    runner,
    outputDirectory,
  );

  const jobDirectory = path.join(
    outputDirectory,
    job.id,
  );

  return {
    root,
    jobs,
    job,
    registry,
    runner,
    executor,
    generator,
    outputDirectory,
    jobDirectory,
  };
}

type Environment = Awaited<
  ReturnType<typeof createEnvironment>
>;

describe("Script generation job lifecycle", () => {
  let environment: Environment | undefined;

  async function setup() {
    environment = await createEnvironment();
    return environment;
  }

  afterEach(async () => {
    if (environment) {
      await rm(environment.root, {
        recursive: true,
        force: true,
      });

      environment = undefined;
    }
  });

  // ----------------------------------------
  // Test 1: Successful job
  // ----------------------------------------

  it("executes a real job and persists script artifacts", async () => {
    const env = await setup();

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("queued");

    const result = await env.executor.execute(
      env.job.id,
    );

    expect(result.status).toBe("completed");

    const storedJob = await env.jobs.get(
      env.job.id,
    );

    expect(storedJob?.status).toBe("completed");

    expect(
      result.stageRuns[0]?.status,
    ).toBe("completed");

    expect(
      env.generator.generate,
    ).toHaveBeenCalledOnce();

    const finalScript = JSON.parse(
      await readFile(
        path.join(
          env.jobDirectory,
          "script",
          "final-script.json",
        ),
        "utf8",
      ),
    );

    expect(finalScript.title).toBe(
      "Why Humans Procrastinate",
    );

    const checkpoint = JSON.parse(
      await readFile(
        path.join(
          env.jobDirectory,
          "checkpoints",
          "script.json",
        ),
        "utf8",
      ),
    );

    expect(checkpoint.status).toBe("completed");

    const report = JSON.parse(
      await readFile(
        path.join(
          env.jobDirectory,
          "execution-report.json",
        ),
        "utf8",
      ),
    );

    expect(report.status).toBe("completed");
    expect(report.jobId).toBe(env.job.id);
  });

  // ----------------------------------------
  // Test 2: Downstream failure and retry
  // ----------------------------------------

  it("retries a downstream failure without regenerating the script", async () => {
    const env = await setup();

    let failAudio = true;

    const audioGeneration = vi.fn(async () => {
      if (failAudio) {
        throw new Error("TTS temporarily unavailable");
      }

      return {
        durationSeconds: 60,
      };
    });

    env.registry.register({
      id: "audio",
      version: "test-v1",
      dependencies: ["script"],

      async execute() {
        return audioGeneration();
      },
    });

    const first = await env.executor.execute(
      env.job.id,
    );

    expect(first.status).toBe("failed");

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("failed");

    expect(
      env.generator.generate,
    ).toHaveBeenCalledOnce();

    await env.executor.retry(env.job.id);

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("queued");

    failAudio = false;

    const second = await env.executor.execute(
      env.job.id,
    );

    expect(second.status).toBe("completed");

    expect(
      second.stageRuns[0]?.status,
    ).toBe("skipped");

    expect(
      second.stageRuns[1]?.status,
    ).toBe("completed");

    expect(
      env.generator.generate,
    ).toHaveBeenCalledOnce();

    expect(audioGeneration).toHaveBeenCalledTimes(2);

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("completed");
  });

  // ----------------------------------------
  // Test 3: Provider failure and retry
  // ----------------------------------------

  it("retries a script generation provider failure", async () => {
    const env = await setup();

    env.generator.generate
      .mockRejectedValueOnce(
        new Error("DeepSeek temporarily unavailable"),
      );

    const first = await env.executor.execute(
      env.job.id,
    );

    expect(first.status).toBe("failed");

    expect(first.stageRuns[0]?.error).toContain(
      "DeepSeek temporarily unavailable",
    );

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("failed");

    await env.executor.retry(env.job.id);

    const second = await env.executor.execute(
      env.job.id,
    );

    expect(second.status).toBe("completed");

    expect(
      env.generator.generate,
    ).toHaveBeenCalledTimes(2);

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("completed");
  });

  // ----------------------------------------
  // Test 4: Interrupted execution recovery
  // ----------------------------------------

  it("recovers an interrupted job and reuses saved script artifacts", async () => {
    const env = await setup();

    // Simulate a process that completed the pipeline
    // but stopped before JobExecutor finalized status.
    const pipelineResult = await env.runner.run(
      env.job,
      env.jobDirectory,
    );

    expect(pipelineResult.status).toBe("completed");

    await env.jobs.update(env.job.id, {
      status: "running",
    });

    await env.executor.recoverInterrupted(
      env.job.id,
    );

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("failed");

    await env.executor.retry(env.job.id);

    const resumed = await env.executor.execute(
      env.job.id,
    );

    expect(resumed.status).toBe("completed");

    expect(
      resumed.stageRuns[0]?.status,
    ).toBe("skipped");

    expect(
      env.generator.generate,
    ).toHaveBeenCalledOnce();

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("completed");
  });

  // ----------------------------------------
  // Test 5: Missing checkpoint recovery
  // ----------------------------------------

  it("recovers saved script artifacts when the checkpoint is missing", async () => {
    const env = await setup();

    let failAudio = true;

    env.registry.register({
      id: "audio",
      version: "test-v1",
      dependencies: ["script"],

      async execute() {
        if (failAudio) {
          throw new Error("Simulated downstream failure");
        }

        return { durationSeconds: 60 };
      },
    });

    const first = await env.executor.execute(
      env.job.id,
    );

    expect(first.status).toBe("failed");

    // Script files exist, but simulate loss of the
    // script checkpoint before recovery.
    await rm(
      path.join(
        env.jobDirectory,
        "checkpoints",
        "script.json",
      ),
      { force: true },
    );

    await env.executor.retry(env.job.id);

    failAudio = false;

    const second = await env.executor.execute(
      env.job.id,
    );

    expect(second.status).toBe("completed");

    // The stage executes but recovers script files.
    expect(
      second.stageRuns[0]?.status,
    ).toBe("completed");

    // No second paid-generation operation.
    expect(
      env.generator.generate,
    ).toHaveBeenCalledOnce();
  });

  // ----------------------------------------
  // Test 6: Corrupted saved script
  // ----------------------------------------

  it("fails safely when saved script artifacts are corrupted", async () => {
    const env = await setup();

    const first = await env.runner.run(
      env.job,
      env.jobDirectory,
    );

    expect(first.status).toBe("completed");

    await writeFile(
      path.join(
        env.jobDirectory,
        "script",
        "final-script.json",
      ),
      "{invalid-json",
      "utf8",
    );

    const second = await env.executor.execute(
      env.job.id,
    );

    expect(second.status).toBe("failed");

    expect(
      second.stageRuns[0]?.status,
    ).toBe("failed");

    expect(
      env.generator.generate,
    ).toHaveBeenCalledOnce();

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("failed");
  });

  // ----------------------------------------
  // Test 7: Readiness failure
  // ----------------------------------------

  it("marks the job failed when the final script fails readiness", async () => {
    const env = await setup();

    // Register a stricter readiness policy in a new
    // registry before the first job execution.
    const strictRegistry = new PipelineRegistry();

    strictRegistry.register(
      createScriptPipelineStage(
        env.generator,
        {
          generationKey: "strict-readiness-v1",
          readiness: {
            enabled: true,
            policy: {
              minimumDurationRatio: 0.9,
              maximumDurationRatio: 1.1,
            },
          },
        },
      ),
    );

    const strictExecutor = new JobExecutor(
      env.jobs,
      new PipelineRunner(strictRegistry),
      env.outputDirectory,
    );

    const result = await strictExecutor.execute(
      env.job.id,
    );

    expect(result.status).toBe("failed");

    expect(result.stageRuns[0]?.error).toContain(
      "Final script readiness failed",
    );

    expect(
      (await env.jobs.get(env.job.id))?.status,
    ).toBe("failed");
  });
});
