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

import { createHash } from "node:crypto";
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
  createScriptPipelineStage,
} from "./script-pipeline-stage.js";

import {
  createStoryboardPipelineStage,
} from "./storyboard-pipeline-stage.js";

import {
  loadVerifiedStoryboardSource,
} from "./verified-storyboard-source.js";

import {
  StoryboardPlanner,
} from "./storyboard-planner.js";

import type {
  StoryboardGenerationConfig,
} from "./storyboard-generation-identity.js";

import {
  createRegisteredModeBMediaStage,
} from "./registered-mode-b-media-stage.js";

import {
  MediaAcquirer,
} from "./media-acquirer.js";

import {
  MediaObjectStore,
} from "./media-object-store.js";

import {
  MediaUsageRightsStore,
} from "./media-usage-rights-store.js";

import type {
  MediaCandidateProvider,
} from "./media-resolver.js";

import {
  getMediaResolutionManifestPath,
} from "./media-pipeline-registration.js";

import {
  inspectMediaCheckpoint,
} from "./media-checkpoint-integrity.js";

import {
  PersistentMediaResolutionStage,
  createMediaStageInputHash,
} from "./persistent-media-resolution.js";

import type {
  MediaStageOutput,
} from "./media-pipeline-stage.js";

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

const customStoryboardConfig: StoryboardGenerationConfig = {
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

import sharp from "sharp";

import {
  createNativeTrustedVisualPreparation,
} from "./native-trusted-visual-preparation.js";

import type {
  StoryboardProductionPackage,
} from "./storyboard-production-package.js";

import type {
  CanonicalShotTiming,
} from "./shot-frame-geometry.js";

import {
  registerNativeVisualStage,
} from "./register-native-visual-stage.js";

import {
  getPersistedVisualPath,
  verifyPersistedVisualRecord,
} from "./persistent-visual-package.js";

import {
  VisualStageOutputSchema,
} from "./visual-pipeline-stage.js";

async function loadActualStoryboardStageOutput(
  jobId: string,
  jobDirectory: string,
): Promise<unknown> {
  const checkpoints = new CheckpointStore(jobDirectory);
  const cp = await checkpoints.load("storyboard");
  return cp?.output;
}

function extractActualM3ShotTimings(
  productionPackage: StoryboardProductionPackage,
): CanonicalShotTiming[] {
  let currentSeconds = 0;
  return productionPackage.mediaPlan.shots.map((shot) => {
    const startSeconds = currentSeconds;
    const endSeconds =
      currentSeconds + shot.estimatedDurationSeconds;
    currentSeconds = endSeconds;
    return {
      shotId: shot.shotId,
      startSeconds,
      endSeconds,
    };
  });
}

async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 3,
      background: "#586b89",
    },
  }).png().toBuffer();
}

async function inspectCompletedVisualCheckpoint(
  jobId: string,
  jobDirectory: string,
) {
  const checkpoints = new CheckpointStore(
    jobDirectory,
  );

  const checkpoint = await checkpoints.load(
    "visual",
  );

  if (!checkpoint) {
    throw new Error(
      "Visual M1 checkpoint is missing",
    );
  }

  const output = VisualStageOutputSchema.parse(
    checkpoint.output,
  );

  const artifactPath = getPersistedVisualPath(
    jobDirectory,
    jobId,
  );

  if (output.artifactPath !== artifactPath) {
    throw new Error(
      "Visual M1 checkpoint artifact path mismatch",
    );
  }

  const record = verifyPersistedVisualRecord(
    JSON.parse(
      await readFile(
        artifactPath,
        "utf8",
      ),
    ),
    jobId,
  );

  if (
    output.packageHash !== record.packageHash ||
    output.visualPackageHash !==
      record.visual.visualPackageHash ||
    output.productionPackageHash !==
      record.visual.productionPackageHash ||
    output.mediaManifestHash !==
      record.visual.mediaManifestHash ||
    output.totalFrames !==
      record.visual.totalFrames ||
    output.shotCount !==
      record.visual.shotCount
  ) {
    throw new Error(
      "Visual checkpoint and persisted record disagree",
    );
  }

  return {
    checkpoint,
    output,
    record,
    artifactPath,
  };
}

describe("Media JobExecutor end-to-end acceptance", () => {
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
        "youcreator-m4-job-executor-",
      ),
    );

    const jobsRoot = path.join(root, "jobs-store");
    const outputDirectory = path.join(root, "output");
    const mediaStorageRoot = path.join(root, "media-storage");
    const localBankRoot = path.join(root, "local-image-bank");

    await mkdir(localBankRoot, { recursive: true });

    const jobs = new JobStore(jobsRoot);

    const job = await jobs.create({
      title: "Why Humans Procrastinate",
      mode: "B",
      durationSeconds: 60,
      resolution: "1920x1080",
      fps: 30,
    });

    const jobDirectory = path.join(outputDirectory, job.id);

    // Setup local fixture image
    const fixturePngPath = path.join(localBankRoot, "fixture.png");
    await writeFile(fixturePngPath, await pngBytes());

    const acquirer = new MediaAcquirer({
      storageRoot: mediaStorageRoot,
      allowedLocalRoots: [localBankRoot],
    });

    const objectStore = new MediaObjectStore({
      storageRoot: mediaStorageRoot,
    });

    const rightsStore = new MediaUsageRightsStore(mediaStorageRoot);

    const source = {
      provider: "local_library" as const,
      id: "m4-acceptance-fixture-asset",
    };

    const acquired = await acquirer.acquire({
      id: source.id,
      provider: source.provider,
      kind: "image",
      description: "Offline acceptance fixture image",
      localPath: fixturePngPath,
      keywords: [],
    });

    const registeredAsset = await objectStore.register(source, {
      ...acquired,
      provenance: {
        ...acquired.provenance,
        source: source.provider,
        providerAssetId: source.id,
      },
    });

    await rightsStore.save({
      source,
      assetHash: registeredAsset.sha256,
      intendedUse: "commercial_youtube",
      reviewer: "acceptance-test",
      reviewedAt: new Date().toISOString(),
      evidenceUrl: "https://example.com/test",
      commercialPermission: "confirmed",
      personRelease: "not_required",
      propertyRelease: "not_required",
      attribution: "not_required",
      notes: "Synthetic acceptance approval",
    });

    let discoveryCalls = 0;
    const localProvider: MediaCandidateProvider = {
      id: "acceptance-local-provider",
      supports: () => true,
      async search(requirement) {
        discoveryCalls += 1;
        return [
          {
            id: source.id,
            provider: "local_library",
            kind: "image",
            description: requirement.description,
            localPath: fixturePngPath,
            width: registeredAsset.width,
            height: registeredAsset.height,
            keywords: [...requirement.searchQueries],
            providerScore: 1,
          },
        ];
      },
    };

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

    const mediaStage = createRegisteredModeBMediaStage({
      registry,
      storageRoot: mediaStorageRoot,
      jobDirectory: (id) => path.join(outputDirectory, id),
      providers: () => [localProvider],
      allowedLocalRoots: () => [localBankRoot],
    });

    const visualRegistration = registerNativeVisualStage({
      registry,

      storageRoot: mediaStorageRoot,

      jobDirectory(jobId) {
        return path.join(outputDirectory, jobId);
      },

      loadStoryboardCheckpoint:
        loadActualStoryboardStageOutput,

      extractTimings:
        extractActualM3ShotTimings,

      fps: 30,
      frameWidth: 1920,
      frameHeight: 1080,
    });

    expect(
      registry.resolveOrder().map(
        (stage) => stage.id,
      ),
    ).toEqual([
      "script",
      "storyboard",
      "media",
      "visual",
    ]);

    const runner = new PipelineRunner(registry);
    const executor = new JobExecutor(
      jobs,
      runner,
      outputDirectory,
    );

    return {
      root,
      outputDirectory,
      mediaStorageRoot,
      localBankRoot,
      jobs,
      job,
      jobDirectory,
      source,
      registeredAsset,
      rightsStore,
      registry,
      runner,
      executor,
      scriptGenerator,
      storyboardLLM,
      mediaStage,
      visualStage: visualRegistration.stage,
      visualStore: visualRegistration.store,
      visualPreparation: visualRegistration.preparation,
      getDiscoveryCalls: () => discoveryCalls,
    };
  }

  it("completes full M1 -> M3 -> M4 job with all stages complete and persisted artifacts", async () => {
    const env = await setup();

    const result = await env.executor.execute(env.job.id);
    expect(result.status).toBe("completed");

    const updatedJob = await env.jobs.get(env.job.id);
    expect(updatedJob?.status).toBe("completed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const scriptCp = await checkpoints.load("script");
    const storyboardCp = await checkpoints.load("storyboard");
    const mediaCp = await checkpoints.load("media");

    expect(scriptCp?.status).toBe("completed");
    expect(storyboardCp?.status).toBe("completed");
    expect(mediaCp?.status).toBe("completed");

    const mediaOutput = mediaCp?.output as MediaStageOutput;
    expect(mediaOutput.mode).toBe("B");
    expect(mediaOutput.shotCount).toBe(4);
    expect(mediaOutput.assignedCount).toBe(4);

    const manifestPath = getMediaResolutionManifestPath(
      env.mediaStorageRoot,
      env.job.id,
    );
    expect(await stat(manifestPath)).toBeDefined();

    const inspection = await inspectMediaCheckpoint(manifestPath);
    expect(inspection.shotIds.length).toBe(4);
    expect(inspection.assetPaths.length).toBe(4);
    expect(inspection.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    const visualCp = await checkpoints.load("visual");
    expect(visualCp?.status).toBe("completed");

    const jobDirectory = path.join(
      env.outputDirectory,
      env.job.id,
    );

    const visual =
      await inspectCompletedVisualCheckpoint(
        env.job.id,
        jobDirectory,
      );

    expect(visual.output.shotCount).toBe(4);

    expect(
      visual.record.visual.shots,
    ).toHaveLength(4);

    expect(
      visual.record.visual.shots[0]?.startFrame,
    ).toBe(0);

    expect(
      visual.record.visual.shots.at(-1)
        ?.endFrameExclusive,
    ).toBe(
      visual.record.visual.totalFrames,
    );

    for (
      let index = 1;
      index < visual.record.visual.shots.length;
      index++
    ) {
      expect(
        visual.record.visual.shots[index]
          ?.startFrame,
      ).toBe(
        visual.record.visual.shots[index - 1]
          ?.endFrameExclusive,
      );
    }
  });

  it("reuses visual checkpoint on retry after downstream stage failure", async () => {
    const env = await setup();

    let audioAttempts = 0;
    const audioStage: PipelineStage = {
      id: "audio",
      version: "acceptance-audio-v1",
      dependencies: ["visual"],

      async execute() {
        audioAttempts += 1;

        if (audioAttempts === 1) {
          throw new Error(
            "Injected downstream audio failure",
          );
        }

        return {
          completed: true,
        };
      },
    };
    env.registry.register(audioStage);

    // Initial run fails at audio
    const firstResult = await env.executor.execute(env.job.id);
    expect(firstResult.status).toBe("failed");

    const jobFailed = await env.jobs.get(env.job.id);
    expect(jobFailed?.status).toBe("failed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    expect((await checkpoints.load("media"))?.status).toBe("completed");
    expect((await checkpoints.load("visual"))?.status).toBe("completed");

    const firstVisual =
      await inspectCompletedVisualCheckpoint(
        env.job.id,
        path.join(env.outputDirectory, env.job.id),
      );

    const discoveryBeforeRetry = env.getDiscoveryCalls();
    expect(discoveryBeforeRetry).toBeGreaterThan(0);

    await env.executor.retry(env.job.id);
    const retryResult = await env.executor.execute(env.job.id);
    expect(retryResult.status).toBe("completed");

    const jobCompleted = await env.jobs.get(env.job.id);
    expect(jobCompleted?.status).toBe("completed");

    const secondVisual =
      await inspectCompletedVisualCheckpoint(
        env.job.id,
        path.join(env.outputDirectory, env.job.id),
      );

    expect(secondVisual.output).toEqual(
      firstVisual.output,
    );

    expect(secondVisual.record).toEqual(
      firstVisual.record,
    );

    expect(env.getDiscoveryCalls()).toBe(
      discoveryBeforeRetry,
    );

    const mediaRun = retryResult.stageRuns.find(
      (s) => s.stageId === "media",
    );
    expect(mediaRun?.status).toBe("skipped");

    const visualRun = retryResult.stageRuns.find(
      (s) => s.stageId === "visual",
    );
    expect(visualRun?.status).toBe("skipped");
  });

  it("recovers from existing verified M4 manifest when M1 media checkpoint is missing", async () => {
    const env = await setup();

    let shouldFail = true;
    const audioStage: PipelineStage = {
      id: "audio",
      version: "test-audio-v1",
      dependencies: ["visual"],
      async execute() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Temporary downstream audio synthesis failure");
        }
        return { audioReady: true };
      },
    };
    env.registry.register(audioStage);

    // Initial run succeeds through visual, fails at audio
    const firstResult = await env.executor.execute(env.job.id);
    expect(firstResult.status).toBe("failed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    expect((await checkpoints.load("media"))?.status).toBe("completed");

    const callsBefore = env.getDiscoveryCalls();
    expect(callsBefore).toBeGreaterThan(0);

    // Delete only M1 media checkpoint
    const checkpointFile = path.join(
      env.jobDirectory,
      "checkpoints",
      "media.json",
    );
    await unlink(checkpointFile);
    expect(await checkpoints.load("media")).toBeNull();

    // Retry job
    await env.executor.retry(env.job.id);

    // Re-run: media stage re-executes, recovering from existing verified M4 manifest without new discovery
    const recoveredResult = await env.executor.execute(env.job.id);
    expect(recoveredResult.status).toBe("completed");

    // Discovery calls did not increase because manifest was reused
    expect(env.getDiscoveryCalls()).toBe(callsBefore);

    const restoredCp = await checkpoints.load("media");
    expect(restoredCp?.status).toBe("completed");
  });

  it("recovers from existing verified M5 persistence when M1 visual checkpoint is missing", async () => {
    const env = await setup();

    let audioAttempts = 0;
    const audioStage: PipelineStage = {
      id: "audio",
      version: "acceptance-audio-v1",
      dependencies: ["visual"],
      async execute() {
        audioAttempts += 1;
        if (audioAttempts === 1) {
          throw new Error("Temporary downstream audio synthesis failure");
        }
        return { completed: true };
      },
    };
    env.registry.register(audioStage);

    // Initial run succeeds through visual, fails at audio
    const firstResult = await env.executor.execute(env.job.id);
    expect(firstResult.status).toBe("failed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    expect((await checkpoints.load("visual"))?.status).toBe("completed");

    const savedVisual =
      await inspectCompletedVisualCheckpoint(
        env.job.id,
        path.join(env.outputDirectory, env.job.id),
      );

    const discoveryBeforeRecovery = env.getDiscoveryCalls();
    expect(discoveryBeforeRecovery).toBeGreaterThan(0);

    // Remove only the M1 visual checkpoint; keep renderer-ready.json intact
    const checkpointFile = path.join(
      env.jobDirectory,
      "checkpoints",
      "visual.json",
    );
    await unlink(checkpointFile);
    expect(await checkpoints.load("visual")).toBeNull();

    // Re-execute through retry mechanism
    await env.executor.retry(env.job.id);
    const recoveredResult = await env.executor.execute(env.job.id);
    expect(recoveredResult.status).toBe("completed");

    const recovered =
      await inspectCompletedVisualCheckpoint(
        env.job.id,
        path.join(env.outputDirectory, env.job.id),
      );

    expect(recovered.record.recordHash).toBe(
      savedVisual.record.recordHash,
    );

    expect(recovered.output.packageHash).toBe(
      savedVisual.output.packageHash,
    );

    expect(env.getDiscoveryCalls()).toBe(
      discoveryBeforeRecovery,
    );
  });

  it("fails closed when a stored media asset is corrupted on disk", async () => {
    const env = await setup();

    let shouldFail = true;
    const audioStage: PipelineStage = {
      id: "audio",
      version: "test-audio-v1",
      dependencies: ["visual"],
      async execute() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Temporary downstream audio failure");
        }
        return { audioReady: true };
      },
    };
    env.registry.register(audioStage);

    // Initial run succeeds through visual, fails at audio
    const firstResult = await env.executor.execute(env.job.id);
    expect(firstResult.status).toBe("failed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const savedVisualCp = await checkpoints.load("visual");
    expect(savedVisualCp?.status).toBe("completed");

    const savedVisualOutput = VisualStageOutputSchema.parse(
      savedVisualCp?.output,
    );

    const visualContext: PipelineContext = {
      job: (await env.jobs.get(env.job.id))!,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        ["script", (await checkpoints.load("script"))?.output],
        ["storyboard", (await checkpoints.load("storyboard"))?.output],
        ["media", (await checkpoints.load("media"))?.output],
      ]),
    };

    // Corrupt stored media object bytes on disk
    await appendFile(
      env.registeredAsset.localPath,
      Buffer.from("CORRUPT_BYTES_TAMPERED"),
    );

    expect(
      await env.visualStage.validateOutput?.(
        savedVisualOutput,
        visualContext,
      ),
    ).toBe(false);

    // Retry job
    await env.executor.retry(env.job.id);

    // Re-execution fails closed because asset SHA256 no longer matches
    const failResult = await env.executor.execute(env.job.id);
    expect(failResult.status).toBe("failed");

    const failedJob = await env.jobs.get(env.job.id);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.error).toMatch(/verification failed/i);
  });

  it("fails closed when media usage rights are missing or rejected", async () => {
    const env = await setup();

    let shouldFail = true;
    const audioStage: PipelineStage = {
      id: "audio",
      version: "test-audio-v1",
      dependencies: ["visual"],
      async execute() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Temporary downstream audio failure");
        }
        return { audioReady: true };
      },
    };
    env.registry.register(audioStage);

    // Initial run succeeds through visual, fails at audio
    const firstResult = await env.executor.execute(env.job.id);
    expect(firstResult.status).toBe("failed");

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const savedVisualCp = await checkpoints.load("visual");
    expect(savedVisualCp?.status).toBe("completed");

    const savedVisualOutput = VisualStageOutputSchema.parse(
      savedVisualCp?.output,
    );

    const visualContext: PipelineContext = {
      job: (await env.jobs.get(env.job.id))!,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        ["script", (await checkpoints.load("script"))?.output],
        ["storyboard", (await checkpoints.load("storyboard"))?.output],
        ["media", (await checkpoints.load("media"))?.output],
      ]),
    };

    // Remove the stored rights manifest directory to revoke/invalidate rights
    const rightsDir = path.join(
      env.mediaStorageRoot,
      "manifests",
      "usage-rights",
    );
    await rm(rightsDir, { recursive: true, force: true });

    expect(
      await env.visualStage.validateOutput?.(
        savedVisualOutput,
        visualContext,
      ),
    ).toBe(false);

    // Retry job
    await env.executor.retry(env.job.id);

    // Re-execution fails closed because rights checker can no longer find approved rights
    const failResult = await env.executor.execute(env.job.id);
    expect(failResult.status).toBe("failed");

    const failedJob = await env.jobs.get(env.job.id);
    expect(failedJob?.status).toBe("failed");
  });

  it("prevents automatic regeneration replay on interrupted paid Mode C attempt", async () => {
    const env = await setup();

    // Create an interrupted attempt marker for a paid Mode C request
    const modeCInput = {
      jobId: env.job.id,
      storyboardSha256: "a".repeat(64),
      mediaPlanSha256: "b".repeat(64),
      stageVersion: "m4-resolution-v1" as const,
      request: {
        jobId: env.job.id,
        mode: "C" as const,
        shotIds: ["shot-001"],
        allowPaidGeneration: true,
      },
    };

    const coordinatorRun = vi.fn();
    const stage = new PersistentMediaResolutionStage({
      storageRoot: env.mediaStorageRoot,
      coordinator: { run: coordinatorRun },
      assetVerifier: { verify: async () => true },
      rightsChecker: { check: async () => "approved" },
      allowNonBillableRecovery: true,
    });

    // Write an incomplete attempt file (simulating interruption before completion)
    const key = createHash("sha256")
      .update(env.job.id)
      .digest("hex");
    const attemptDir = path.join(
      env.mediaStorageRoot,
      "media-resolution",
      key,
    );
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      path.join(attemptDir, "attempt.json"),
      JSON.stringify({
        version: 1,
        inputHash: createMediaStageInputHash(modeCInput),
        jobId: env.job.id,
        startedAt: new Date().toISOString(),
      }),
    );

    // Re-running must reject and MUST NOT call coordinator to generate
    await expect(stage.run(modeCInput)).rejects.toThrow(
      "Media resolution has an incomplete prior attempt; manual recovery required",
    );

    expect(coordinatorRun).toHaveBeenCalledTimes(0);
  });

  it("produces deterministic visual preparation without new media discovery on repeat", async () => {
    const env = await setup();
    await env.executor.execute(env.job.id);

    const visualPreparation = createNativeTrustedVisualPreparation({
      storageRoot: env.mediaStorageRoot,
      jobDirectory: (id) => path.join(env.outputDirectory, id),
      loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
      extractTimings: extractActualM3ShotTimings,
      fps: 30,
      frameWidth: 1920,
      frameHeight: 1080,
    });

    const callsBefore = env.getDiscoveryCalls();
    const first = await visualPreparation.prepare({ jobId: env.job.id });
    const second = await visualPreparation.prepare({ jobId: env.job.id });

    expect(first.visual.visualPackageHash).toBe(second.visual.visualPackageHash);
    expect(second.visual).toEqual(first.visual);
    expect(env.getDiscoveryCalls()).toBe(callsBefore);
  });

  it("rejects visual preparation when stored media asset is corrupted", async () => {
    const env = await setup();
    await env.executor.execute(env.job.id);

    const visualPreparation = createNativeTrustedVisualPreparation({
      storageRoot: env.mediaStorageRoot,
      jobDirectory: (id) => path.join(env.outputDirectory, id),
      loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
      extractTimings: extractActualM3ShotTimings,
    });

    await appendFile(
      env.registeredAsset.localPath,
      Buffer.from("CORRUPT_BYTES"),
    );

    await expect(
      visualPreparation.prepare({ jobId: env.job.id }),
    ).rejects.toThrow();
  });

  it("fails closed when media usage rights are revoked during visual preparation", async () => {
    const env = await setup();
    await env.executor.execute(env.job.id);

    const visualPreparation = createNativeTrustedVisualPreparation({
      storageRoot: env.mediaStorageRoot,
      jobDirectory: (id) => path.join(env.outputDirectory, id),
      loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
      extractTimings: extractActualM3ShotTimings,
    });

    const rightsDir = path.join(
      env.mediaStorageRoot,
      "manifests",
      "usage-rights",
    );
    await rm(rightsDir, { recursive: true, force: true });

    await expect(
      visualPreparation.prepare({ jobId: env.job.id }),
    ).rejects.toThrow();
  });

  it("fails visual preparation and invalidates checkpoint when M3 production package is altered", async () => {
    const env = await setup();
    await env.executor.execute(env.job.id);

    const checkpoints = new CheckpointStore(env.jobDirectory);
    const savedVisualCp = await checkpoints.load("visual");
    expect(savedVisualCp?.status).toBe("completed");

    const savedVisualOutput = VisualStageOutputSchema.parse(
      savedVisualCp?.output,
    );

    const visualContext: PipelineContext = {
      job: (await env.jobs.get(env.job.id))!,
      jobDirectory: env.jobDirectory,
      outputs: new Map([
        ["script", (await checkpoints.load("script"))?.output],
        ["storyboard", (await checkpoints.load("storyboard"))?.output],
        ["media", (await checkpoints.load("media"))?.output],
      ]),
    };

    const pkgPath = path.join(
      env.jobDirectory,
      "storyboard",
      "production-package.json",
    );
    await writeFile(pkgPath, JSON.stringify({ tampered: true }));

    expect(
      await env.visualStage.validateOutput?.(
        savedVisualOutput,
        visualContext,
      ),
    ).toBe(false);

    const visualPreparation = createNativeTrustedVisualPreparation({
      storageRoot: env.mediaStorageRoot,
      jobDirectory: (id) => path.join(env.outputDirectory, id),
      loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
      extractTimings: extractActualM3ShotTimings,
    });

    await expect(
      visualPreparation.prepare({ jobId: env.job.id }),
    ).rejects.toThrow();
  });

  it("rejects tampered visual persistence without silently repairing or overwriting it", async () => {
    const env = await setup();

    let shouldFail = true;
    const audioStage: PipelineStage = {
      id: "audio",
      version: "test-audio-v1",
      dependencies: ["visual"],
      async execute() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Temporary downstream audio failure");
        }
        return { audioReady: true };
      },
    };
    env.registry.register(audioStage);

    // Initial run succeeds through visual, fails at audio
    const firstResult = await env.executor.execute(env.job.id);
    expect(firstResult.status).toBe("failed");

    const savedVisual =
      await inspectCompletedVisualCheckpoint(
        env.job.id,
        path.join(env.outputDirectory, env.job.id),
      );

    const tampered = structuredClone(
      savedVisual.record,
    );

    tampered.visual.totalFrames += 30;

    const tamperedJson = JSON.stringify(tampered);

    await writeFile(
      savedVisual.artifactPath,
      tamperedJson,
    );

    await env.executor.retry(env.job.id);
    const failResult = await env.executor.execute(env.job.id);
    expect(failResult.status).toBe("failed");

    const fileAfterAttempt = await readFile(
      savedVisual.artifactPath,
      "utf8",
    );
    expect(fileAfterAttempt).toBe(tamperedJson);
  });

  it("fails visual preparation without media reacquisition when M4 manifest is missing", async () => {
    const env = await setup();
    await env.executor.execute(env.job.id);

    const visualPreparation = createNativeTrustedVisualPreparation({
      storageRoot: env.mediaStorageRoot,
      jobDirectory: (id) => path.join(env.outputDirectory, id),
      loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
      extractTimings: extractActualM3ShotTimings,
    });

    const manifestPath = getMediaResolutionManifestPath(
      env.mediaStorageRoot,
      env.job.id,
    );
    await unlink(manifestPath);

    const callsBefore = env.getDiscoveryCalls();

    await expect(
      visualPreparation.prepare({ jobId: env.job.id }),
    ).rejects.toThrow(/missing or unreadable/i);

    expect(env.getDiscoveryCalls()).toBe(callsBefore);
  });

  it("rejects visual preparation when previously saved camera plan was tampered", async () => {
    const env = await setup();
    await env.executor.execute(env.job.id);

    const visualPreparation = createNativeTrustedVisualPreparation({
      storageRoot: env.mediaStorageRoot,
      jobDirectory: (id) => path.join(env.outputDirectory, id),
      loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
      extractTimings: extractActualM3ShotTimings,
    });

    const genuine = await visualPreparation.prepare({ jobId: env.job.id });
    const tamperedMotion = structuredClone(genuine.motion);
    tamperedMotion.shots[0]!.startScale = 1.12;
    const { motionPackageHash: _old, ...payload } = tamperedMotion;
    tamperedMotion.motionPackageHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    await expect(
      visualPreparation.prepare({
        jobId: env.job.id,
        expected: { motion: tamperedMotion },
      }),
    ).rejects.toThrow(/Noncanonical visual package: motion/i);
  });
});
