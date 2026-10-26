import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  CheckpointStore,
  JobExecutor,
  JobStore,
  PipelineRegistry,
  PipelineRunner,
  type PipelineContext,
  type PipelineStage,
} from "@youcreator/core";

import {
  runOfflineModeBAcceptance,
} from "./mode-b-offline-acceptance.js";

import {
  inspectMediaCheckpoint,
} from "./media-checkpoint-integrity.js";

import {
  createScriptPipelineStage,
} from "./script-pipeline-stage.js";

import {
  createStoryboardPipelineStage,
  type StoryboardStageOutput,
} from "./storyboard-pipeline-stage.js";

import {
  loadVerifiedStoryboardSource,
} from "./verified-storyboard-source.js";

import {
  StoryboardPlanner,
} from "./storyboard-planner.js";

import {
  getStoryboardArtifactPath,
  loadStoryboardJobArtifact,
} from "./storyboard-job-artifacts.js";

import type {
  StoryboardGenerationConfig,
} from "./storyboard-generation-identity.js";

import {
  evaluateStoryboardAcceptance,
} from "./storyboard-acceptance.js";

import {
  hashScriptContent,
} from "./script-job-artifacts.js";

const scriptFixture = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook:
    "You sit down to work, but suddenly everything else feels more important.",
  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",
      narration:
        "People sometimes delay difficult tasks because avoiding them provides temporary emotional relief.",
      estimatedDurationSeconds: 12,
    },
  ],
  outro:
    "Next time this happens, set a timer for two minutes and begin with the easiest part.",
};

const finalScriptFixture = {
  ...scriptFixture,
  outro:
    "Next time this happens, set a timer for two minutes and start the easiest task.",
};

const storyboardConfig: StoryboardGenerationConfig = {
  provider: "deepseek",
  model: "test-model",
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
};

function createMockStoryboardLLM() {
  const generate = vi.fn(
    async (
      messages: Array<{ role: string; content: string }>,
    ) => {
      const userMessage = messages.find(
        (m) => m.role === "user",
      );
      if (!userMessage) {
        throw new Error("Missing user message in LLM request");
      }

      const payload = JSON.parse(userMessage.content);
      const slots: Array<{
        slot: number;
        narration: string;
      }> = payload.slots ?? [];

      const plan = {
        scenes: [
          {
            purpose: `Visual narrative for ${payload.segmentId}`,
            shots: slots.map((s) => ({
              slot: s.slot,
              visualRequest: {
                description:
                  "A focused person sitting quietly at a wooden desk with an open laptop",
                searchQueries: [
                  `person working at desk slot ${s.slot}`,
                ],
                intent: "illustration",
                preferredMediaKind: "either",
                negativeTerms: [],
              },
              motion: "slow_zoom_in",
              transition: "cut",
            })),
          },
        ],
      };

      return {
        text: JSON.stringify(plan),
        model: "test-deepseek-chat",
      };
    },
  );

  return { generate };
}

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33);

  Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]).copy(bytes);

  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");

  bytes.writeUInt32BE(1920, 16);
  bytes.writeUInt32BE(1080, 20);

  bytes[24] = 8;
  bytes[25] = 2;

  return bytes;
}

describe("Script-to-storyboard full acceptance", () => {
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

  async function setup(
    customStoryboardConfig = storyboardConfig,
  ) {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-acceptance-m3-",
      ),
    );

    const jobsRoot = path.join(root, "jobs-store");
    const outputDirectory = path.join(root, "output");

    const jobs = new JobStore(jobsRoot);

    const job = await jobs.create({
      title: "Why Humans Procrastinate",
      mode: "B",
      durationSeconds: 60,
      resolution: "1920x1080",
      fps: 30,
    });

    const scriptGenerator = {
      generate: vi.fn(async () => ({
        script: scriptFixture,
        finalScript: finalScriptFixture,
        llmUsage: {
          requests: 4,
          failedRequests: 0,
          reservedOutputTokens: 4096,
          reportedInputTokens: 150,
          reportedOutputTokens: 240,
        },
        promotion: {
          promoted: true,
          reason: "Candidate passed editorial validation",
        },
      })),
    };

    const scriptStage = createScriptPipelineStage(
      scriptGenerator,
      {
        generationKey: "deepseek:prompt-v1",
        readiness: {
          enabled: true,
          policy: {
            minimumDurationRatio: 0.01,
            maximumDurationRatio: 10,
          },
        },
      },
    );

    const storyboardLLM = createMockStoryboardLLM();
    const storyboardPlanner = new StoryboardPlanner(
      storyboardLLM,
      {
        profile: "documentary",
        maxWordsPerShot: 12,
        wordsPerMinute: 135,
      },
    );

    const storyboardStage =
      createStoryboardPipelineStage({
        planner: storyboardPlanner,
        loadFinalScript: loadVerifiedStoryboardSource,
        mode: "B",
        profile: "documentary",
        plannerGenerationConfig: customStoryboardConfig,
      });

    const registry = new PipelineRegistry();
    registry.register(scriptStage);
    registry.register(storyboardStage);

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
      jobDirectory,
      outputDirectory,
      registry,
      runner,
      executor,
      scriptGenerator,
      storyboardLLM,
      storyboardPlanner,
      scriptStage,
      storyboardStage,
      finalScript: finalScriptFixture,
    };
  }

  it("completes full M2 -> M3 execution with checkpoints and expected call counts", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const updatedJob = await env.jobs.get(env.job.id);
    expect(updatedJob?.status).toBe("completed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const scriptCheckpoint = await checkpoints.load("script");
    const storyboardCheckpoint =
      await checkpoints.load("storyboard");

    expect(scriptCheckpoint).not.toBeNull();
    expect(scriptCheckpoint?.status).toBe("completed");

    expect(storyboardCheckpoint).not.toBeNull();
    expect(storyboardCheckpoint?.status).toBe("completed");

    // 1 call for M2 script generation
    expect(env.scriptGenerator.generate).toHaveBeenCalledTimes(1);
    // 3 segment calls for M3 storyboard (hook, section-001, outro)
    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(3);
  });

  it("completes full M3 -> M4 offline media resolution and checkpoint reuse", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const updatedJob = await env.jobs.get(env.job.id);
    expect(updatedJob?.status).toBe("completed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const scriptCheckpoint = await checkpoints.load("script");
    const storyboardCheckpoint =
      await checkpoints.load("storyboard");

    const context: PipelineContext = {
      job: updatedJob!,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        ["script", scriptCheckpoint?.output],
        ["storyboard", storyboardCheckpoint?.output],
      ]),
    };

    const imageBankDir = path.join(
      env.root,
      "local-image-bank",
    );
    await mkdir(imageBankDir, { recursive: true });

    const fixturePath = path.join(
      imageBankDir,
      "fixture.png",
    );
    await writeFile(fixturePath, pngBytes());

    const result = await runOfflineModeBAcceptance({
      context,

      storageRoot: path.join(
        env.root,
        "media-storage",
      ),

      localImagePath: fixturePath,

      allowedLocalRoot: imageBankDir,
    });

    expect(result.output.mode).toBe("B");

    expect(result.output.assignedCount).toBe(
      result.output.shotCount,
    );

    expect(result.reusedOutputValid).toBe(true);

    expect(result.discoveryCalls).toBeGreaterThan(0);

    expect(
      await stat(result.manifestPath),
    ).toBeDefined();

    // The completed media checkpoint must be valid.
    expect(
      await result.validateCheckpoint(),
    ).toBe(true);

    const inspection = await inspectMediaCheckpoint(
      result.manifestPath,
    );

    expect(inspection.shotIds.length).toBe(
      result.output.shotCount,
    );

    expect(inspection.assetPaths.length).toBe(
      result.output.assignedCount,
    );

    const originalManifest = await readFile(
      result.manifestPath,
      "utf8",
    );

    // 1. A modified manifest must not be reusable.
    const tampered = JSON.parse(
      originalManifest,
    ) as Record<string, unknown>;

    tampered.inputHash = "f".repeat(64);

    await writeFile(
      result.manifestPath,
      JSON.stringify(tampered),
    );

    expect(
      await result.validateCheckpoint(),
    ).toBe(false);

    // Restore the original manifest to isolate the next
    // failure scenario.
    await writeFile(
      result.manifestPath,
      originalManifest,
    );

    expect(
      await result.validateCheckpoint(),
    ).toBe(true);

    // 2. Corrupt one real stored object.
    // Do this ONLY in the temporary acceptance storage,
    // never in a production object store.
    const target = inspection.assetPaths[0];

    if (!target) {
      throw new Error(
        "Acceptance test has no stored media asset",
      );
    }

    await appendFile(
      target,
      Buffer.from("CORRUPTED-ACCEPTANCE-FIXTURE"),
    );

    // Manifest and checkpoint are unchanged, but
    // stored bytes are no longer the original object.
    expect(
      await result.validateCheckpoint(),
    ).toBe(false);
  });

  it("guarantees final-script authority", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const cp = await checkpoints.load("storyboard");
    const output = cp?.output as StoryboardStageOutput;

    const stored = await loadStoryboardJobArtifact({
      jobsRoot: env.outputDirectory,
      jobId: env.job.id,
      expectedGenerationFingerprint:
        output.generationFingerprint,
      expectedScriptHash: output.scriptHash,
    });

    expect(stored.package.script).toEqual(env.finalScript);
    expect(stored.package.scriptHash).toBe(
      hashScriptContent(env.finalScript),
    );
  });

  it("preserves 100% narration coverage without duplicates or missing words", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const cp = await checkpoints.load("storyboard");
    const output = cp?.output as StoryboardStageOutput;

    const stored = await loadStoryboardJobArtifact({
      jobsRoot: env.outputDirectory,
      jobId: env.job.id,
      expectedGenerationFingerprint:
        output.generationFingerprint,
      expectedScriptHash: output.scriptHash,
    });

    expect(stored.package.coverage.passed).toBe(true);
    expect(stored.package.coverage.issues).toHaveLength(0);
    expect(stored.package.coverage.expectedWords).toBe(
      stored.package.coverage.coveredWords,
    );
    expect(stored.package.coverage.expectedSegments).toBe(
      stored.package.coverage.coveredSegments,
    );

    const report = evaluateStoryboardAcceptance(
      env.finalScript,
      stored.package,
    );
    expect(report.passed).toBe(true);
    expect(report.narrationCoveragePassed).toBe(true);
    expect(report.mediaQAPassed).toBe(true);
    expect(report.scriptMatches).toBe(true);
  });

  it("verifies full artifact integrity and matching generation fingerprint", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const cp = await checkpoints.load("storyboard");
    const output = cp?.output as StoryboardStageOutput;

    const stored = await loadStoryboardJobArtifact({
      jobsRoot: env.outputDirectory,
      jobId: env.job.id,
      expectedGenerationFingerprint:
        output.generationFingerprint,
      expectedScriptHash: output.scriptHash,
    });

    expect(stored.package.packageHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(stored.generationFingerprint).toBe(
      output.generationFingerprint,
    );
  });

  it("reuses script and storyboard on downstream failure and retry with zero new LLM calls", async () => {
    const env = await setup();

    let shouldFail = true;
    const audioStage: PipelineStage = {
      id: "audio",
      version: "test-audio-v1",
      dependencies: ["storyboard"],
      async execute() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Simulated audio provider failure");
        }
        return { audioReady: true };
      },
    };

    env.registry.register(audioStage);

    // Initial execution: audio fails
    const firstResult = await env.runner.run(
      env.job,
      env.jobDirectory,
    );
    expect(firstResult.status).toBe("failed");

    expect(env.scriptGenerator.generate).toHaveBeenCalledTimes(1);
    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(3);

    // Retry execution: audio succeeds, upstream stages skipped
    const retryResult = await env.runner.run(
      env.job,
      env.jobDirectory,
    );
    expect(retryResult.status).toBe("completed");

    // Zero additional LLM calls
    expect(env.scriptGenerator.generate).toHaveBeenCalledTimes(1);
    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(3);
  });

  it("recovers saved production package when storyboard checkpoint is missing", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(3);

    // Delete storyboard checkpoint only
    await unlink(
      path.join(
        env.jobDirectory,
        "checkpoints",
        "storyboard.json",
      ),
    );

    const checkpoints = new CheckpointStore(env.jobDirectory);
    expect(await checkpoints.load("storyboard")).toBeNull();

    // Re-run
    const runResult = await env.runner.run(
      env.job,
      env.jobDirectory,
    );

    expect(runResult.status).toBe("completed");
    // LLM must NOT be called again
    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(3);

    // Checkpoint restored
    expect(await checkpoints.load("storyboard")).not.toBeNull();
  });

  it("fails without regenerating when storyboard package is corrupted", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    // Corrupt the package file
    const packagePath = getStoryboardArtifactPath(
      env.outputDirectory,
      env.job.id,
    );
    await writeFile(packagePath, "{ invalid json", "utf8");

    // Remove checkpoint to force stage execution
    await unlink(
      path.join(
        env.jobDirectory,
        "checkpoints",
        "storyboard.json",
      ),
    );

    const runResult = await env.runner.run(
      env.job,
      env.jobDirectory,
    );

    expect(runResult.status).toBe("failed");
    // No new LLM calls
    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(3);
  });

  it("fails safely when storyboard config changes against an existing artifact", async () => {
    const env = await setup();

    await env.executor.execute(env.job.id);

    // Create a new runner with a modified storyboard configuration
    const modifiedConfig: StoryboardGenerationConfig = {
      ...storyboardConfig,
      model: "deepseek-v3",
    };

    const newRegistry = new PipelineRegistry();
    newRegistry.register(env.scriptStage);
    newRegistry.register(
      createStoryboardPipelineStage({
        planner: env.storyboardPlanner,
        loadFinalScript: loadVerifiedStoryboardSource,
        mode: "B",
        profile: "documentary",
        plannerGenerationConfig: modifiedConfig,
      }),
    );

    const newRunner = new PipelineRunner(newRegistry);

    // Remove checkpoint to trigger stage execution with new config
    await unlink(
      path.join(
        env.jobDirectory,
        "checkpoints",
        "storyboard.json",
      ),
    );

    const runResult = await newRunner.run(
      env.job,
      env.jobDirectory,
    );

    // Mismatched configuration fingerprint fails safely without overwriting
    expect(runResult.status).toBe("failed");
    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(3);
  });

  it("fails before storyboard LLM call when M2 script artifact is corrupted", async () => {
    const env = await setup();

    // Run script stage first
    const scriptOnlyRegistry = new PipelineRegistry();
    scriptOnlyRegistry.register(env.scriptStage);
    const scriptRunner = new PipelineRunner(
      scriptOnlyRegistry,
    );

    const scriptRun = await scriptRunner.run(
      env.job,
      env.jobDirectory,
    );
    expect(scriptRun.status).toBe("completed");

    // Corrupt M2 final-script.json
    const finalScriptPath = path.join(
      env.jobDirectory,
      "script",
      "final-script.json",
    );
    await writeFile(
      finalScriptPath,
      JSON.stringify({
        ...env.finalScript,
        title: "Tampered Title",
      }),
      "utf8",
    );

    // Attempt to run full pipeline
    const runResult = await env.runner.run(
      env.job,
      env.jobDirectory,
    );

    expect(runResult.status).toBe("failed");
    // Storyboard LLM must never have been called
    expect(env.storyboardLLM.generate).toHaveBeenCalledTimes(0);
  });
});
