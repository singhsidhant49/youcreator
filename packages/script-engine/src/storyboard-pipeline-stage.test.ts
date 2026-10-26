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
  unlink,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  PipelineRegistry,
  PipelineRunner,
  JobStore,
  JobExecutor,
  type PipelineStage,
} from "@youcreator/core";

import {
  createStoryboardPipelineStage,
} from "./storyboard-pipeline-stage.js";

import {
  getStoryboardArtifactPath,
} from "./storyboard-job-artifacts.js";

import {
  productionFixture,
} from "./storyboard-production.test-fixture.js";

describe("Storyboard pipeline lifecycle", () => {
  let root: string | undefined;

  async function setup(
    plannerGenerationKey = "test-planner-v1",
  ) {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-m3-"),
    );

    const outputRoot = path.join(root, "output");

    const fixture = productionFixture();

    const planner = {
      plan: vi.fn(async () => fixture.storyboard),
    };

    const scriptStage: PipelineStage = {
      id: "script",
      version: "test-script-v1",
      dependencies: [],

      async execute() {
        return { ready: true };
      },
    };

    const storyboardStage =
      createStoryboardPipelineStage({
        planner,

        loadFinalScript: async () => fixture.script,

        mode: "B",
        profile: "documentary",
        plannerGenerationKey,
      });

    const registry = new PipelineRegistry();
    registry.register(scriptStage);
    registry.register(storyboardStage);

    const runner = new PipelineRunner(registry);

    const jobs = new JobStore(
      path.join(root, "job-store"),
    );

    const executor = new JobExecutor(
      jobs,
      runner,
      outputRoot,
    );

    const job = await jobs.create({
      title: "Why Humans Procrastinate",
      mode: "B",
      durationSeconds: 60,
      resolution: "1920x1080",
      fps: 30,
    });

    return {
      fixture,
      planner,
      registry,
      jobs,
      executor,
      job,
      outputRoot,
    };
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

  it("executes script and storyboard to completion", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const saved = await env.jobs.get(env.job.id);

    expect(saved?.status).toBe("completed");

    expect(env.planner.plan).toHaveBeenCalledTimes(1);

    const filename = getStoryboardArtifactPath(
      env.outputRoot,
      env.job.id,
    );

    const parsed = JSON.parse(
      await readFile(filename, "utf8"),
    );

    expect(parsed.package.coverage.passed).toBe(true);
    expect(parsed.package.mediaQA.passed).toBe(true);
  });

  it("reuses valid storyboard checkpoint on downstream retry", async () => {
    const env = await setup();

    let failAudio = true;
    const audioGeneration = vi.fn(async () => {
      if (failAudio) {
        throw new Error("TTS temporarily unavailable");
      }
      return { durationSeconds: 60 };
    });

    env.registry.register({
      id: "audio",
      version: "test-audio-v1",
      dependencies: ["storyboard"],
      async execute() {
        return audioGeneration();
      },
    });

    const first = await env.executor.execute(env.job.id);
    expect(first.status).toBe("failed");
    expect((await env.jobs.get(env.job.id))?.status).toBe("failed");
    expect(env.planner.plan).toHaveBeenCalledTimes(1);

    await env.executor.retry(env.job.id);
    expect((await env.jobs.get(env.job.id))?.status).toBe("queued");

    failAudio = false;
    const second = await env.executor.execute(env.job.id);
    expect(second.status).toBe("completed");
    expect((await env.jobs.get(env.job.id))?.status).toBe("completed");

    expect(
      second.stageRuns.find((s) => s.stageId === "script")?.status,
    ).toBe("skipped");
    expect(
      second.stageRuns.find((s) => s.stageId === "storyboard")?.status,
    ).toBe("skipped");
    expect(
      second.stageRuns.find((s) => s.stageId === "audio")?.status,
    ).toBe("completed");

    expect(env.planner.plan).toHaveBeenCalledTimes(1);
    expect(audioGeneration).toHaveBeenCalledTimes(2);
  });

  it("recovers existing package if checkpoint is missing", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    expect(env.planner.plan).toHaveBeenCalledTimes(1);

    const jobDirectory = path.join(
      env.outputRoot,
      env.job.id,
    );

    await unlink(
      path.join(
        jobDirectory,
        "checkpoints",
        "storyboard.json",
      ),
    );

    // Run the pipeline directly to exercise
    // artifact recovery after checkpoint loss.
    // A completed job cannot be requeued normally.
    const registry = new PipelineRegistry();

    registry.register({
      id: "script",
      version: "test-script-v1",
      dependencies: [],
      execute: async () => ({ ready: true }),
    });

    registry.register(
      createStoryboardPipelineStage({
        planner: env.planner,
        loadFinalScript: async () =>
          env.fixture.script,
        mode: "B",
        profile: "documentary",
        plannerGenerationKey:
          "test-planner-v1",
      }),
    );

    const runner = new PipelineRunner(registry);

    const result = await runner.run(
      env.job,
      jobDirectory,
    );

    expect(result.status).toBe("completed");
    expect(env.planner.plan).toHaveBeenCalledTimes(1);
  });

  it("fails when saved narration is corrupted", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const filename = getStoryboardArtifactPath(
      env.outputRoot,
      env.job.id,
    );

    const saved = JSON.parse(
      await readFile(filename, "utf8"),
    );

    saved.package.storyboard.sections[0]
      .scenes[0].shots[0].narrationText =
      "Altered narration.";

    await writeFile(
      filename,
      JSON.stringify(saved),
      "utf8",
    );

    const registry = new PipelineRegistry();

    registry.register({
      id: "script",
      version: "test-script-v1",
      dependencies: [],
      execute: async () => ({ ready: true }),
    });

    registry.register(
      createStoryboardPipelineStage({
        planner: env.planner,
        loadFinalScript: async () =>
          env.fixture.script,
        mode: "B",
        profile: "documentary",
        plannerGenerationKey:
          "test-planner-v1",
      }),
    );

    const runner = new PipelineRunner(registry);

    const result = await runner.run(
      env.job,
      path.join(env.outputRoot, env.job.id),
    );

    expect(result.status).toBe("failed");

    expect(env.planner.plan).toHaveBeenCalledTimes(1);
  });

  it("rejects changed planner configuration", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const registry = new PipelineRegistry();

    registry.register({
      id: "script",
      version: "test-script-v1",
      dependencies: [],
      execute: async () => ({ ready: true }),
    });

    registry.register(
      createStoryboardPipelineStage({
        planner: env.planner,
        loadFinalScript: async () =>
          env.fixture.script,
        mode: "B",
        profile: "documentary",
        plannerGenerationKey:
          "test-planner-v2",
      }),
    );

    const runner = new PipelineRunner(registry);

    const result = await runner.run(
      env.job,
      path.join(env.outputRoot, env.job.id),
    );

    expect(result.status).toBe("failed");
    expect(env.planner.plan).toHaveBeenCalledTimes(1);
  });

  it("records planner failure without publishing a package", async () => {
    const env = await setup();

    const registry = new PipelineRegistry();

    registry.register({
      id: "script",
      version: "test-script-v1",
      dependencies: [],
      execute: async () => ({ ready: true }),
    });

    const failedPlanner = {
      plan: vi.fn(async () => {
        throw new Error("Simulated provider failure");
      }),
    };

    registry.register(
      createStoryboardPipelineStage({
        planner: failedPlanner,
        loadFinalScript: async () =>
          env.fixture.script,
        mode: "B",
        profile: "documentary",
        plannerGenerationKey:
          "test-planner-v1",
      }),
    );

    const runner = new PipelineRunner(registry);

    const result = await runner.run(
      env.job,
      path.join(env.outputRoot, env.job.id),
    );

    expect(result.status).toBe("failed");

    await expect(
      readFile(
        getStoryboardArtifactPath(
          env.outputRoot,
          env.job.id,
        ),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("blocks concurrent stage execution for the same job and calls planner only once", async () => {
    const env = await setup();

    let releasePlanner!: () => void;
    const plannerCanFinish = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });

    let markStarted!: () => void;
    const plannerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const concurrentPlanner = {
      plan: vi.fn(async () => {
        markStarted();
        await plannerCanFinish;
        return env.fixture.storyboard;
      }),
    };

    const registry = new PipelineRegistry();
    registry.register({
      id: "script",
      version: "test-script-v1",
      dependencies: [],
      execute: async () => ({ ready: true }),
    });

    registry.register(
      createStoryboardPipelineStage({
        planner: concurrentPlanner,
        loadFinalScript: async () => env.fixture.script,
        mode: "B",
        profile: "documentary",
        plannerGenerationKey: "test-planner-v1",
      }),
    );

    const runner = new PipelineRunner(registry);
    const jobDir = path.join(env.outputRoot, env.job.id);

    const firstRunPromise = runner.run(env.job, jobDir);

    await plannerStarted;

    const secondRunResult = await runner.run(env.job, jobDir);

    releasePlanner();
    const firstRunResult = await firstRunPromise;

    expect(firstRunResult.status).toBe("completed");
    expect(secondRunResult.status).toBe("failed");
    const storyboardFailure = secondRunResult.stageRuns.find(
      (run) => run.stageId === "storyboard",
    );
    expect(storyboardFailure?.error).toMatch(
      /Storyboard generation already locked for job/,
    );
    expect(concurrentPlanner.plan).toHaveBeenCalledTimes(1);
  });

  it("accepts structured plannerGenerationConfig and rejects profile mismatch", async () => {
    const env = await setup();

    const stage = createStoryboardPipelineStage({
      planner: env.planner,
      loadFinalScript: async () => env.fixture.script,
      mode: "B",
      profile: "documentary",
      plannerGenerationConfig: {
        provider: "deepseek",
        model: "deepseek-chat",
        promptVersion: "storyboard-v1",
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
      },
    });

    expect(stage.id).toBe("storyboard");
    expect(stage.version).toMatch(/^m3-10b:[a-f0-9]{64}$/);

    expect(() =>
      createStoryboardPipelineStage({
        planner: env.planner,
        loadFinalScript: async () => env.fixture.script,
        mode: "B",
        profile: "educational",
        plannerGenerationConfig: {
          provider: "deepseek",
          model: "deepseek-chat",
          promptVersion: "storyboard-v1",
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
        },
      }),
    ).toThrow("Storyboard profile does not match planner configuration");
  });
});

