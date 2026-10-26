import {
  afterEach,
  expect,
  vi,
} from "vitest";

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";
import sharp from "sharp";

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
  AUDIO_ALIGNED_VISUAL_STAGE_ID,
} from "./audio-aligned-visual-stage.js";

import {
  AudioAlignedVisualCheckpointSchema,
  getPersistedAudioAlignedVisualPath,
} from "./persistent-audio-aligned-visual.js";

import {
  createNativeAudioAlignedVisualPipeline,
} from "./native-audio-aligned-visual.js";

import {
  createNativeM6SourceLoader,
} from "./native-m6-source-loader.js";

import {
  createM6JobExecutorBridge,
} from "./m6-job-executor-bridge.js";

import {
  createM6NativeExecutionContract,
} from "./m6-native-execution-contract.js";

import {
  getPersistedVisualPath,
  verifyPersistedVisualRecord,
} from "./persistent-visual-package.js";

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
  registerNativeVisualStage,
} from "./register-native-visual-stage.js";

import type {
  StoryboardProductionPackage,
} from "./storyboard-production-package.js";

import type {
  CanonicalShotTiming,
} from "./shot-frame-geometry.js";

import {
  PersistentCaptionedNarrationStore,
} from "./persistent-captioned-narration.js";

import {
  CaptionedNarrationService,
} from "./captioned-narration-service.js";

import {
  createNarrationAudio,
} from "./narration-audio-contract.js";

import {
  createNarrationWordAlignment,
  tokenizeNarrationScript,
} from "./narration-alignment-contract.js";

import type {
  KokoroCaptionedTtsProvider,
  KokoroCaptionedRequest,
  KokoroCaptionedResult,
} from "./kokoro-captioned-tts-provider.js";

import {
  registerM6NativeExecutionAcceptance,
  type M6AcceptanceDriver,
  type M6AcceptanceRun,
} from "./m6-native-execution-acceptance.js";

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

function wavFixture(frames = 72000): Buffer {
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);
  return wav;
}

const createdRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (createdRoots.length > 0) {
    const r = createdRoots.pop();
    if (r) {
      await rm(r, { recursive: true, force: true }).catch(() => {});
    }
  }
});

interface DriverContext {
  root: string;
  jobsRoot: string;
  outputDirectory: string;
  mediaStorageRoot: string;
  localBankRoot: string;
  source: { id: string; provider: "local_library" };
  registeredAsset: { sha256: string; width: number; height: number };
  rightsStore: MediaUsageRightsStore;
  captionedNarrationService: CaptionedNarrationService;
  counters: {
    ttsCalls: number;
    mediaAcquisitions: number;
  };
}

function assembleDriver(ctx: DriverContext): M6AcceptanceDriver {
  const jobs = new JobStore(ctx.jobsRoot);

  const localProvider: MediaCandidateProvider = {
    id: "acceptance-local-provider",
    supports: () => true,
    async search(requirement) {
      ctx.counters.mediaAcquisitions += 1;
      return [
        {
          id: ctx.source.id,
          provider: "local_library",
          kind: "image",
          description: requirement.description,
          localPath: path.join(ctx.localBankRoot, "fixture.png"),
          width: ctx.registeredAsset.width,
          height: ctx.registeredAsset.height,
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

  const storyboardStage = createStoryboardPipelineStage({
    planner: storyboardPlanner,
    loadFinalScript: loadVerifiedStoryboardSource,
    mode: "B",
    profile: "documentary",
    plannerGenerationConfig: customStoryboardConfig,
  });

  // 1. Pipeline registry with upstream stages
  const registry = new PipelineRegistry();
  registry.register(scriptStage);
  registry.register(storyboardStage);

  createRegisteredModeBMediaStage({
    registry,
    storageRoot: ctx.mediaStorageRoot,
    jobDirectory: (id) => path.join(ctx.outputDirectory, id),
    providers: () => [localProvider],
    allowedLocalRoots: () => [ctx.localBankRoot],
  });

  const visualRegistration = registerNativeVisualStage({
    registry,
    storageRoot: ctx.mediaStorageRoot,
    jobDirectory: (id) => path.join(ctx.outputDirectory, id),
    loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
    extractTimings: extractActualM3ShotTimings,
    fps: 30,
    frameWidth: 1920,
    frameHeight: 1080,
  });

  // 2. M6 Native Source Loader
  const sourceLoader = createNativeM6SourceLoader({
    fps: 30,

    async loadVerifiedBindings(jobId: string) {
      const prepared = await visualRegistration.preparation.prepare({
        jobId,
      });
      return prepared.bindings;
    },

    async loadVerifiedM5Visual(jobId: string) {
      const m5Path = getPersistedVisualPath(
        path.join(ctx.outputDirectory, jobId),
        jobId,
      );
      const content = await readFile(m5Path, "utf8");
      const record = verifyPersistedVisualRecord(
        JSON.parse(content),
        jobId,
      );
      return record.visual;
    },

    async loadVerifiedNarrationAnchoring(jobId: string) {
      const m5Path = getPersistedVisualPath(
        path.join(ctx.outputDirectory, jobId),
        jobId,
      );
      const content = await readFile(m5Path, "utf8");
      const record = verifyPersistedVisualRecord(
        JSON.parse(content),
        jobId,
      );
      const m5Visual = record.visual;

      const scriptText = m5Visual.shots
        .map((_, i) => `Word${i}.`)
        .join(" ");

      const narrationResult =
        await ctx.captionedNarrationService.generate({
          jobId,
          input: scriptText,
        });

      const audio = createNarrationAudio(
        jobId,
        narrationResult.audioBytes,
      );

      const alignment = narrationResult.alignment;

      const shots = m5Visual.shots.map((shot, index) => ({
        shotId: shot.shotId,
        shotIndex: index,
        startTokenIndex: index * 2,
        endTokenIndexExclusive: (index + 1) * 2,
      }));

      return {
        jobId,
        productionPackageHash: m5Visual.productionPackageHash,
        scriptText,
        audio,
        alignment,
        shots,
      };
    },

    async loadVerifiedM3ShotIds(jobId: string) {
      const m5Path = getPersistedVisualPath(
        path.join(ctx.outputDirectory, jobId),
        jobId,
      );
      const content = await readFile(m5Path, "utf8");
      const record = verifyPersistedVisualRecord(
        JSON.parse(content),
        jobId,
      );
      return record.visual.shots.map((s) => s.shotId);
    },

    async verifyCurrentMediaRights(jobId: string) {
      const assessment = await ctx.rightsStore.load({
        source: ctx.source,
        assetHash: ctx.registeredAsset.sha256,
        intendedUse: "commercial_youtube",
        reviewer: "lookup-only",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        commercialPermission: "unknown",
        personRelease: "unknown",
        propertyRelease: "unknown",
        attribution: "unknown",
        notes: "",
      });
      if (
        !assessment ||
        assessment.decision !== "approved"
      ) {
        throw new Error("Media usage rights revoked");
      }
    },
  });

  // 3. M6 Stage and Bridge
  const m6Pipeline = createNativeAudioAlignedVisualPipeline({
    jobDirectory: (id) => path.join(ctx.outputDirectory, id),
    sourceLoader,
  });

  const bridge = createM6JobExecutorBridge(m6Pipeline.stage);
  const m6Contract = createM6NativeExecutionContract(bridge);

  const audioAlignedVisualStage: PipelineStage = {
    id: AUDIO_ALIGNED_VISUAL_STAGE_ID,
    version: "m6-audio-aligned-visual-v1",
    dependencies: ["visual"],
    outputSchema: AudioAlignedVisualCheckpointSchema,
    async execute(context: PipelineContext) {
      const result = await m6Contract.run({
        jobId: context.job.id,
      });
      return result.checkpoint;
    },
    async validateOutput(output: unknown, context: PipelineContext) {
      return await m6Contract.validate(
        { jobId: context.job.id },
        output,
      );
    },
  };

  registry.register(audioAlignedVisualStage);

  const runner = new PipelineRunner(registry);
  const executor = new JobExecutor(jobs, runner, ctx.outputDirectory);

  return {
    async execute(jobId: string): Promise<M6AcceptanceRun> {
      // Ensure job status is queued so real JobExecutor can run
      const jobPath = path.join(ctx.jobsRoot, `${jobId}.json`);
      const jobRaw = await readFile(jobPath, "utf8");
      const jobData = JSON.parse(jobRaw);
      if (jobData.status !== "queued") {
        jobData.status = "queued";
        delete jobData.error;
        await writeFile(
          jobPath,
          JSON.stringify(jobData, null, 2),
          "utf8",
        );
      }

      const result = await executor.execute(jobId);

      if (result.status === "failed") {
        const failedStage = result.stageRuns.find(
          (s) => s.status === "failed",
        );
        throw new Error(
          failedStage?.error ?? "Pipeline execution failed",
        );
      }

      const checkpoints = new CheckpointStore(
        path.join(ctx.outputDirectory, jobId),
      );
      const cp = await checkpoints.load(
        AUDIO_ALIGNED_VISUAL_STAGE_ID,
      );

      if (!cp) {
        throw new Error(
          "Missing audio_aligned_visual checkpoint after execution",
        );
      }

      return {
        checkpoint: AudioAlignedVisualCheckpointSchema.parse(
          cp.output,
        ),
      };
    },

    async restart(): Promise<M6AcceptanceDriver> {
      return assembleDriver(ctx);
    },

    async readCheckpoint(
      jobId: string,
      stageId: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID,
    ): Promise<unknown> {
      const checkpoints = new CheckpointStore(
        path.join(ctx.outputDirectory, jobId),
      );
      const cp = await checkpoints.load(stageId);
      return cp?.output;
    },

    async kokoroCallCount(): Promise<number> {
      return ctx.counters.ttsCalls;
    },

    async mediaAcquisitionCount(): Promise<number> {
      return ctx.counters.mediaAcquisitions;
    },

    async readM5Bytes(jobId: string): Promise<Buffer> {
      const m5Path = getPersistedVisualPath(
        path.join(ctx.outputDirectory, jobId),
        jobId,
      );
      return await readFile(m5Path);
    },

    async corruptM6Artifact(jobId: string): Promise<void> {
      const artifactPath = getPersistedAudioAlignedVisualPath(
        path.join(ctx.outputDirectory, jobId),
        jobId,
      );
      await writeFile(
        artifactPath,
        JSON.stringify({ corrupted: true, jobId }),
        "utf8",
      );
    },

    async removeM6Checkpoint(jobId: string): Promise<void> {
      const cpPath = path.join(
        ctx.outputDirectory,
        jobId,
        "checkpoints",
        `${AUDIO_ALIGNED_VISUAL_STAGE_ID}.json`,
      );
      await rm(cpPath, { force: true });
    },

    async prepare(scenario: string): Promise<string> {
      const job = await jobs.create({
        title: `Acceptance ${scenario}`,
        mode: "B",
        durationSeconds: 30,
        resolution: "1920x1080",
        fps: 30,
      });

      // Construct upstream registry (without M6 stage) to complete upstream stages
      const upstreamRegistry = new PipelineRegistry();
      upstreamRegistry.register(scriptStage);
      upstreamRegistry.register(storyboardStage);

      createRegisteredModeBMediaStage({
        registry: upstreamRegistry,
        storageRoot: ctx.mediaStorageRoot,
        jobDirectory: (id) => path.join(ctx.outputDirectory, id),
        providers: () => [localProvider],
        allowedLocalRoots: () => [ctx.localBankRoot],
      });

      registerNativeVisualStage({
        registry: upstreamRegistry,
        storageRoot: ctx.mediaStorageRoot,
        jobDirectory: (id) => path.join(ctx.outputDirectory, id),
        loadStoryboardCheckpoint: loadActualStoryboardStageOutput,
        extractTimings: extractActualM3ShotTimings,
        fps: 30,
        frameWidth: 1920,
        frameHeight: 1080,
      });

      const upstreamRunner = new PipelineRunner(upstreamRegistry);
      const upstreamExecutor = new JobExecutor(
        jobs,
        upstreamRunner,
        ctx.outputDirectory,
      );

      const upstreamResult = await upstreamExecutor.execute(job.id);
      if (upstreamResult.status === "failed") {
        throw new Error("Upstream preparation failed");
      }

      // Pre-synthesize captioned narration for the upstream shots
      const m5Path = getPersistedVisualPath(
        path.join(ctx.outputDirectory, job.id),
        job.id,
      );
      const m5Content = await readFile(m5Path, "utf8");
      const m5Record = verifyPersistedVisualRecord(
        JSON.parse(m5Content),
        job.id,
      );
      const scriptText = m5Record.visual.shots
        .map((_, i) => `Word${i}.`)
        .join(" ");

      await ctx.captionedNarrationService.generate({
        jobId: job.id,
        input: scriptText,
      });

      // Reset job to queued state on disk
      const jobPath = path.join(ctx.jobsRoot, `${job.id}.json`);
      const jobData = JSON.parse(await readFile(jobPath, "utf8"));
      jobData.status = "queued";
      delete jobData.error;
      await writeFile(
        jobPath,
        JSON.stringify(jobData, null, 2),
        "utf8",
      );

      return job.id;
    },
  };
}

async function createDriver(): Promise<M6AcceptanceDriver> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "youcreator-m6-acceptance-"),
  );
  createdRoots.push(root);

  const jobsRoot = path.join(root, "jobs-store");
  const outputDirectory = path.join(root, "output");
  const mediaStorageRoot = path.join(root, "media-storage");
  const localBankRoot = path.join(root, "local-image-bank");

  await mkdir(localBankRoot, { recursive: true });
  await mkdir(jobsRoot, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(mediaStorageRoot, { recursive: true });

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
    id: "acceptance-fixture-asset",
    provider: "local_library" as const,
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

  const counters = {
    ttsCalls: 0,
    mediaAcquisitions: 0,
  };

  const mockKokoroProvider: KokoroCaptionedTtsProvider = {
    async synthesize(
      request: KokoroCaptionedRequest,
    ): Promise<KokoroCaptionedResult> {
      counters.ttsCalls += 1;
      const tokens = tokenizeNarrationScript(request.input);
      const sampleRate = 24000;
      const wordDuration = 0.5;
      const totalDuration = tokens.length * wordDuration + 0.5;
      const sampleFrames = Math.ceil(totalDuration * sampleRate);
      const wavBytes = wavFixture(sampleFrames);
      const audio = createNarrationAudio(request.jobId, wavBytes);

      const timestamps = tokens.map((token, index) => ({
        word: token,
        start_time: index * wordDuration + 0.05,
        end_time: (index + 1) * wordDuration,
      }));

      const alignment = createNarrationWordAlignment({
        scriptText: request.input,
        audio,
        timestamps,
      });

      return {
        audioBytes: wavBytes,
        audio,
        alignment,
      };
    },
  } as unknown as KokoroCaptionedTtsProvider;

  const narrationStore = new PersistentCaptionedNarrationStore(
    (jobId) => path.join(outputDirectory, jobId),
  );

  const captionedNarrationService = new CaptionedNarrationService({
    provider: mockKokoroProvider,
    store: narrationStore,
    jobDirectory: (jobId) => path.join(outputDirectory, jobId),
    defaultVoice: "af_heart",
    defaultSpeed: 1,
    providerId: "kokoro",
    endpointVersion: "v1",
  });

  const ctx: DriverContext = {
    root,
    jobsRoot,
    outputDirectory,
    mediaStorageRoot,
    localBankRoot,
    source,
    registeredAsset,
    rightsStore,
    captionedNarrationService,
    counters,
  };

  return assembleDriver(ctx);
}

registerM6NativeExecutionAcceptance(createDriver);
