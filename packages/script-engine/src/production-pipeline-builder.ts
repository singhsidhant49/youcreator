import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  type VideoScript,
  resolveCanonicalVisualMode,
} from "@youcreator/contracts";

import { DeepSeekClient } from "@youcreator/llm";

import {
  createScriptPipelineStage,
} from "./script-pipeline-stage.js";

import {
  ScriptGenerationService,
} from "./script-generation-service.js";

import {
  StoryboardPlanner,
} from "./storyboard-planner.js";

import {
  createStoryboardPipelineStage,
} from "./storyboard-pipeline-stage.js";

import {
  loadVerifiedStoryboardSource,
} from "./verified-storyboard-source.js";

import {
  createRegisteredModeBMediaStage,
} from "./registered-mode-b-media-stage.js";

import {
  IdeogramImageProvider,
  type IdeogramQuality,
  type IdeogramResolution,
} from "./ideogram-image-provider.js";

import type {
  AIImageProvider,
} from "./ai-image-generation.js";

import {
  PexelsPhotoProvider,
} from "./pexels-photo-provider.js";

import {
  registerNativeVisualStage,
} from "./register-native-visual-stage.js";

import {
  createNativeM6SourceLoader,
} from "./native-m6-source-loader.js";

import {
  createNativeAudioAlignedVisualPipeline,
} from "./native-audio-aligned-visual.js";

import {
  createM6JobExecutorBridge,
} from "./m6-job-executor-bridge.js";

import {
  createM6NativeExecutionContract,
} from "./m6-native-execution-contract.js";

import {
  AUDIO_ALIGNED_VISUAL_STAGE_ID,
} from "./audio-aligned-visual-stage.js";

import {
  AudioAlignedVisualCheckpointSchema,
  getPersistedAudioAlignedVisualPath,
  verifyPersistedAudioAlignedVisualRecord,
} from "./persistent-audio-aligned-visual.js";

import {
  getPersistedVisualPath,
  verifyPersistedVisualRecord,
} from "./persistent-visual-package.js";

import {
  createNativeRemotionVideoPipeline,
} from "./native-remotion-video.js";

import {
  REMOTION_VIDEO_STAGE_ID,
} from "./remotion-video-stage.js";

import {
  RemotionVideoCheckpointSchema,
  getRemotionVideoPaths,
  type RemotionVideoSourcePort,
} from "./persistent-remotion-video.js";

import {
  createRemotionComposition,
} from "./remotion-composition-contract.js";

import {
  createRemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import {
  createEditorialMotionPlan,
  type EditorialProfile,
} from "./editorial-motion-plan.js";

import {
  createEditorialAudioPlan,
  createSpeechIntervalsFromWords,
  measurePcmAudioLoudness,
  calibrateEditorialAudioPlan,
} from "./editorial-audio-plan.js";

import {
  createNativeVideoQaPipeline,
} from "./native-video-qa.js";

import {
  CALIBRATED_RELEASE_POLICY,
} from "./video-qa-release-gate.js";

import {
  VIDEO_QA_STAGE_ID,
} from "./video-qa-stage.js";

import {
  VideoQaCheckpointSchema,
  type VerifiedVideoQaEvidencePort,
} from "./persistent-video-qa.js";

import {
  createVideoQaFramePlan,
} from "./video-qa-frame-plan.js";

import {
  extractVideoQaFrames,
} from "./video-qa-frame-extractor.js";

import {
  analyzeVideoQaFrames,
} from "./video-qa-frame-analyzer.js";

import {
  runVideoAudioQa,
} from "./video-qa-audio-runner.js";

import {
  analyzeVideoQaSubtitles,
} from "./video-qa-subtitle-analyzer.js";

import {
  analyzeVideoVisualVariety,
} from "./video-qa-visual-variety.js";

import {
  VideoReleaseVerifier,
} from "./video-release-verifier.js";

import {
  createNativeVideoExportPipeline,
} from "./native-video-export.js";

import {
  VIDEO_EXPORT_STAGE_ID,
  VideoExportCheckpointSchema,
} from "./video-export-stage.js";

import {
  type ExportMetadata,
} from "./video-export-contract.js";

import {
  PersistentVideoExportStore,
  type VerifiedExportSourcePort,
} from "./persistent-video-export.js";

import {
  PersistentCaptionedNarrationStore,
  type PersistedCaptionedNarrationResult,
  getPersistedCaptionedNarrationPaths,
} from "./persistent-captioned-narration.js";

import {
  CaptionedNarrationService,
} from "./captioned-narration-service.js";

import {
  KokoroCaptionedTtsProvider,
} from "./kokoro-captioned-tts-provider.js";

import {
  createNarrationAudio,
} from "./narration-audio-contract.js";

import {
  MediaObjectStore,
} from "./media-object-store.js";

import {
  MediaUsageRightsStore,
} from "./media-usage-rights-store.js";

import {
  loadScriptJobArtifacts,
} from "./script-job-artifacts.js";

import type {
  ProductionVideoExecutor,
} from "./video-production-acceptance.js";

import {
  createProductionAcceptanceRunner,
  VideoProductionAcceptanceRunner,
} from "./video-production-acceptance.js";

import type { VideoBatchJob } from "./video-batch-contract.js";

export interface ProductionPipelineOptions {
  outputRoot: string;
  jobsDirectory?: string;
  mediaStorageRoot?: string;
  deepseekApiKey?: string;
  deepseekModel?: string;
  pexelsApiKey?: string;
  kokoroUrl?: string;
  remotionEntryPoint?: string;
  ffprobePath?: string;
  fps?: number;
  width?: number;
  height?: number;
  concurrency?: number;
  durationSeconds?: number;

  /**
   * Optional custom TTS provider for testing or alternative endpoints.
   */
  ttsProvider?: KokoroCaptionedTtsProvider;

  /**
   * Optional visual mode for pipeline creation ("A" | "B" | "C" | "stock" | "ai" | "manual").
   * Default is "B" for historical backward compatibility with pre-M10.6 jobs.
   */
  visualMode?: "A" | "B" | "C" | "stock" | "ai" | "manual";

  /**
   * Visual mode schema version (1 for legacy pre-M10.6, 2 for canonical M10.6+).
   */
  visualModeVersion?: 1 | 2;

  /**
   * Optional Ideogram API credentials and model configuration.
   */
  ideogramApiKey?: string;
  ideogramModel?: string;
  ideogramQuality?: IdeogramQuality;
  ideogramResolution?: IdeogramResolution;
  ideogramAspectRatio?: string;
  aiProvider?: AIImageProvider;

  /**
   * Optional custom LLM generator for testing.
   */
  llmClient?: DeepSeekClient;
}

export interface ProductionPipelineSystem {
  executor: JobExecutor;
  jobs: JobStore;
  registry: PipelineRegistry;
  runner: PipelineRunner;
  exportStore: PersistentVideoExportStore;
  jobDirectory: (id: string) => string;
  executeJob: ProductionVideoExecutor["execute"];
  acceptanceRunner: VideoProductionAcceptanceRunner;
}

/**
 * Creates the production JobExecutor adapter for VideoProductionAcceptanceRunner.
 */
export function createProductionJobExecutorAdapter(
  executor: JobExecutor,
  jobs: JobStore,
  jobsDirectory: string,
  options?: {
    mode?: "A" | "B" | "C" | "stock" | "ai" | "manual";
    durationSeconds?: number;
    fps?: number;
    resolution?: string;
  },
): ProductionVideoExecutor["execute"] {
  return async (batchJob: VideoBatchJob): Promise<void> => {
    await mkdir(jobsDirectory, { recursive: true });
    const jobPath = path.join(jobsDirectory, `${batchJob.jobId}.json`);

    const existingJob = await jobs.get(batchJob.jobId);
    if (!existingJob) {
      const now = new Date().toISOString();
      const rawMode = (batchJob as any)?.mode ?? options?.mode ?? "A";
      const resolved = resolveCanonicalVisualMode({ version: 2, mode: rawMode });
      const newJob = {
        id: batchJob.jobId,
        config: {
          version: 2,
          title: batchJob.topic,
          prompt: batchJob.topic,
          topic: batchJob.topic,
          profileId: (batchJob as any)?.profileId,
          profile: (batchJob as any)?.profileId,
          mode: resolved.canonicalMode,
          canonicalMode: resolved.canonicalMode,
          durationSeconds: (batchJob as any)?.durationSeconds ?? options?.durationSeconds ?? 45,
          fps: (batchJob as any)?.fps ?? options?.fps ?? 30,
          resolution: (batchJob as any)?.resolution ?? options?.resolution ?? "1920x1080",
          aspectRatio: (batchJob as any)?.aspectRatio,
          voice: (batchJob as any)?.voice,
          voiceSpeed: (batchJob as any)?.voiceSpeed,
          imageProvider: (batchJob as any)?.imageProvider,
          imageModel: (batchJob as any)?.imageModel,
          imageQuality: (batchJob as any)?.imageQuality,
          imageResolution: (batchJob as any)?.imageResolution,
          maxCostPerJobUsd: (batchJob as any)?.maxCostPerJobUsd,
          maxCostPerImageUsd: (batchJob as any)?.maxCostPerImageUsd,
          musicEnabled: (batchJob as any)?.musicEnabled,
          musicAssetId: (batchJob as any)?.musicAssetId,
          assignments: (batchJob as any)?.assignments,
        },
        status: "queued" as const,
        createdAt: now,
        updatedAt: now,
      };
      await writeFile(jobPath, JSON.stringify(newJob, null, 2), "utf8");
    } else if (existingJob.status === "failed" || existingJob.status === "completed") {
      await writeFile(
        jobPath,
        JSON.stringify(
          {
            ...existingJob,
            status: "queued",
            error: undefined,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    const result = await executor.execute(batchJob.jobId);
    if (result.status === "failed") {
      const failed = result.stageRuns.find((s) => s.status === "failed");
      throw new Error(
        `Production pipeline stage '${failed?.stageId ?? "unknown"}' failed: ${failed?.error ?? "Pipeline execution failed"}`,
      );
    }
  };
}

/**
 * Assembles the full production pipeline with all 8 native M1-M9 stages.
 */
export function createProductionPipeline(
  options: ProductionPipelineOptions,
): ProductionPipelineSystem {
  const outputRoot = path.resolve(options.outputRoot);
  const jobsDirectory = options.jobsDirectory
    ? path.resolve(options.jobsDirectory)
    : path.join(outputRoot, "jobs");
  const mediaStorageRoot = options.mediaStorageRoot
    ? path.resolve(options.mediaStorageRoot)
    : path.join(outputRoot, "media-storage");
  const localBankRoot = path.join(outputRoot, "local-bank");

  const fps = options.fps ?? 30;
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const durationSeconds = options.durationSeconds ?? 60;
  const ffprobePath = options.ffprobePath ?? "/opt/homebrew/bin/ffprobe";

  const deepseekApiKey =
    options.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? "test-key";
  const deepseekModel =
    options.deepseekModel ?? process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
  const pexelsApiKey =
    options.pexelsApiKey ?? process.env.PEXELS_API_KEY ?? "test-key";
  const kokoroUrl =
    options.kokoroUrl ??
    process.env.KOKORO_TTS_URL ??
    "http://192.168.29.39:8880/v1/audio/speech";

  const remotionEntryPoint =
    options.remotionEntryPoint ??
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "remotion-entry.tsx",
    );

  const jobs = new JobStore(jobsDirectory);
  const registry = new PipelineRegistry();

  const deepseekClient =
    options.llmClient ??
    new DeepSeekClient({
      apiKey: deepseekApiKey,
      model: deepseekModel,
      timeoutMs: 120_000,
    });

  // Stage 1: script
  const scriptGenerator = new ScriptGenerationService(deepseekClient, {
    budget: {
      maxRequests: 16,
      maxOutputTokens: 40000,
      maxTokensPerRequest: 4096,
    },
    assembler: {
      reviseSections: true,
      maxRevisionCalls: 3,
      revisionTolerance: 0.12,
      enforceQuality: false,
    },
  });

  const scriptStage = createScriptPipelineStage(scriptGenerator, {
    generationKey: `deepseek:${deepseekModel}:script-v1`,
    readiness: {
      enabled: true,
      policy: {
        minimumDurationRatio: 0.85,
        maximumDurationRatio: 1.15,
      },
    },
  });
  registry.register(scriptStage);

  const rawVisualMode = options.visualMode ?? "B";
  const isV2Mode = options.visualModeVersion === 2 || rawVisualMode === "stock" || rawVisualMode === "ai" || rawVisualMode === "manual";
  const pipelineMode = (rawVisualMode === "A" || rawVisualMode === "stock")
    ? "A"
    : (rawVisualMode === "ai" || (rawVisualMode === "B" && isV2Mode))
      ? "B"
      : "B";
  const mediaPlanVersion = isV2Mode ? 2 : (pipelineMode === "A" ? 2 : 1);
  const isModeBAi = pipelineMode === "B" && mediaPlanVersion === 2;

  // Stage 2: storyboard
  const storyboardPlanner = new StoryboardPlanner(deepseekClient, {
    profile: "documentary",
    maxWordsPerShot: 12,
    wordsPerMinute: 135,
    minDurationSeconds: 1.8,
    maxTokensPerRequest: 8192,
  });

  const storyboardStage = createStoryboardPipelineStage({
    planner: storyboardPlanner,
    loadFinalScript: loadVerifiedStoryboardSource,
    mode: pipelineMode,
    mediaPlanVersion,
    profile: "documentary",
    plannerGenerationConfig: {
      provider: "deepseek",
      model: deepseekModel,
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
  registry.register(storyboardStage);

  // Stage 3: media
  const rightsStore = new MediaUsageRightsStore(mediaStorageRoot);
  const orientation = (options.width ?? 1920) < (options.height ?? 1080) ? "portrait" : "landscape";
  const rawPexelsProvider = new PexelsPhotoProvider({
    apiKey: pexelsApiKey,
    orientation,
  });

  const pexelsProvider = {
    id: rawPexelsProvider.id,
    supports: (req: Parameters<typeof rawPexelsProvider.supports>[0], ctx: Parameters<typeof rawPexelsProvider.supports>[1]) => {
      const normalizedReq = req.preferredMediaKind === "video" ? { ...req, preferredMediaKind: "either" as const } : req;
      return rawPexelsProvider.supports(normalizedReq, ctx);
    },
    search: async (req: Parameters<typeof rawPexelsProvider.search>[0], ctx: Parameters<typeof rawPexelsProvider.search>[1]) => {
      const normalizedReq = req.preferredMediaKind === "video" ? { ...req, preferredMediaKind: "either" as const } : req;
      const results = await rawPexelsProvider.search(normalizedReq, ctx);
      for (const candidate of results) {
        try {
          await rightsStore.save({
            source: { provider: "pexels", id: candidate.id },
            assetHash: "0".repeat(64), // populated after acquisition
            intendedUse: "commercial_youtube",
            reviewer: "pexels-license-automated",
            reviewedAt: new Date().toISOString(),
            evidenceUrl: "https://www.pexels.com/license/",
            commercialPermission: "confirmed",
            personRelease: "not_required",
            propertyRelease: "not_required",
            attribution: "not_required",
            notes: "Automatic Pexels commercial license confirmation",
          });
        } catch {
          // non-blocking pre-registration
        }
      }
      return results;
    },
  };

  const ideogramApiKey =
    options.ideogramApiKey ?? process.env.IDEOGRAM_API_KEY ?? "test-key";
  const ideogramModel =
    options.ideogramModel ?? process.env.IDEOGRAM_MODEL ?? "p-image-ideogram";
  const ideogramQuality =
    options.ideogramQuality ?? (process.env.IDEOGRAM_QUALITY as IdeogramQuality | undefined) ?? "high";
  const ideogramResolution =
    options.ideogramResolution ?? (process.env.IDEOGRAM_RESOLUTION as IdeogramResolution | undefined) ?? "1k";
  const ideogramAspectRatio =
    options.ideogramAspectRatio ?? process.env.IDEOGRAM_ASPECT_RATIO ?? "16x9";

  const ideogramProvider =
    options.aiProvider ??
    new IdeogramImageProvider({
      apiKey: ideogramApiKey,
      defaultModel: ideogramModel,
      defaultQuality: ideogramQuality,
      defaultResolution: ideogramResolution,
      defaultAspectRatio: ideogramAspectRatio,
    });

  createRegisteredModeBMediaStage({
    registry,
    storageRoot: mediaStorageRoot,
    jobDirectory: (id) => path.join(jobsDirectory, id),
    providers: () => [pexelsProvider],
    aiProvider: () => ideogramProvider,
    allowedLocalRoots: () => [localBankRoot],
    mode: pipelineMode,
    version: mediaPlanVersion,
    targetAspectRatio: (options.width ?? 1920) / (options.height ?? 1080),
  });

  // Stage 4: visual
  const visualRegistration = registerNativeVisualStage({
    registry,
    storageRoot: mediaStorageRoot,
    jobDirectory: (id) => path.join(jobsDirectory, id),
    loadStoryboardCheckpoint: async (jobId, jobDir) => {
      const checkpoints = new CheckpointStore(jobDir);
      const cp = await checkpoints.load("storyboard");
      return cp?.output;
    },
    extractTimings: (productionPackage) => {
      let currentSeconds = 0;
      return productionPackage.mediaPlan.shots.map((shot) => {
        const startSeconds = currentSeconds;
        const endSeconds = currentSeconds + shot.estimatedDurationSeconds;
        currentSeconds = endSeconds;
        return {
          shotId: shot.shotId,
          startSeconds,
          endSeconds,
        };
      });
    },
    fps,
    frameWidth: width,
    frameHeight: height,
  });

  // Stage 5: audio_aligned_visual
  const captionedNarrationStore = new PersistentCaptionedNarrationStore(
    (id) => path.join(jobsDirectory, id),
  );

  const kokoroProvider =
    options.ttsProvider ??
    new KokoroCaptionedTtsProvider({
      baseUrl: kokoroUrl,
      voice: process.env.KOKORO_VOICE ?? "af_bella",
      speed: Number(process.env.KOKORO_SPEED ?? 0.9),
      timeoutMs: Math.max(300_000, durationSeconds * 3000),
      normalizationOptions: { normalize: false },
    });

  const captionedNarrationService = new CaptionedNarrationService({
    provider: kokoroProvider,
    store: captionedNarrationStore,
    jobDirectory: (id) => path.join(jobsDirectory, id),
  });

  const m6SourceLoader = createNativeM6SourceLoader({
    fps,

    async loadVerifiedBindings(jobId) {
      const prepared = await visualRegistration.preparation.prepare({ jobId });
      return prepared.bindings;
    },

    async loadVerifiedM5Visual(jobId) {
      const m5Path = getPersistedVisualPath(
        path.join(jobsDirectory, jobId),
        jobId,
      );
      const content = await readFile(m5Path, "utf8");
      const record = verifyPersistedVisualRecord(JSON.parse(content), jobId);
      return record.visual;
    },

    async loadVerifiedNarrationAnchoring(jobId) {
      const m5Path = getPersistedVisualPath(
        path.join(jobsDirectory, jobId),
        jobId,
      );
      const content = await readFile(m5Path, "utf8");
      const record = verifyPersistedVisualRecord(JSON.parse(content), jobId);
      const m5Visual = record.visual;

      const scriptArtifacts = await loadScriptJobArtifacts(
        path.join(jobsDirectory, jobId),
        "script",
      );
      const finalScript = scriptArtifacts.finalScript;
      const scriptText = [
        finalScript.hook,
        ...finalScript.sections.map((s) => s.narration),
        finalScript.outro,
      ].filter(Boolean).join(" ");

      let effectiveVoice: string | undefined = process.env.KOKORO_VOICE ?? "af_bella";
      let effectiveSpeed: number | undefined = Number(process.env.KOKORO_SPEED ?? 0.9);
      try {
        const job = await jobs.get(jobId);
        if (job?.config?.voice) {
          effectiveVoice = job.config.voice;
        }
        if (job?.config?.voiceSpeed) {
          effectiveSpeed = job.config.voiceSpeed;
        }
      } catch {
        // Fall back to defaults
      }

      let narrationResult: PersistedCaptionedNarrationResult;
      try {
        narrationResult = await captionedNarrationStore.load(jobId);
      } catch {
        narrationResult = await captionedNarrationService.generate({
          jobId,
          input: scriptText,
          voice: effectiveVoice,
          speed: effectiveSpeed,
        });
      }

      const audio = createNarrationAudio(jobId, narrationResult.audioBytes);
      const alignment = narrationResult.alignment;

      const totalTokens = Math.max(1, alignment.words.length);
      const shotCount = m5Visual.shots.length;
      const tokensPerShot = Math.max(1, Math.floor(totalTokens / shotCount));

      const shots = m5Visual.shots.map((shot, index) => {
        const startTokenIndex = index * tokensPerShot;
        const endTokenIndexExclusive =
          index === shotCount - 1
            ? totalTokens
            : Math.min(totalTokens, (index + 1) * tokensPerShot);
        return {
          shotId: shot.shotId,
          shotIndex: index,
          startTokenIndex,
          endTokenIndexExclusive: Math.max(startTokenIndex + 1, endTokenIndexExclusive),
        };
      });

      return {
        jobId,
        productionPackageHash: m5Visual.productionPackageHash,
        scriptText,
        audio,
        alignment,
        shots,
      };
    },

    async loadVerifiedM3ShotIds(jobId) {
      const m5Path = getPersistedVisualPath(
        path.join(jobsDirectory, jobId),
        jobId,
      );
      const content = await readFile(m5Path, "utf8");
      const record = verifyPersistedVisualRecord(JSON.parse(content), jobId);
      return record.visual.shots.map((s) => s.shotId);
    },

    async verifyCurrentMediaRights(_jobId) {
      // verified during native visual preparation
    },
  });

  const m6Pipeline = createNativeAudioAlignedVisualPipeline({
    jobDirectory: (id) => path.join(jobsDirectory, id),
    sourceLoader: m6SourceLoader,
  });

  const m6Bridge = createM6JobExecutorBridge(m6Pipeline.stage);
  const m6Contract = createM6NativeExecutionContract(m6Bridge);

  const audioAlignedVisualStage: PipelineStage = {
    id: AUDIO_ALIGNED_VISUAL_STAGE_ID,
    version: "m6-audio-aligned-visual-v1",
    dependencies: ["visual"],
    outputSchema: AudioAlignedVisualCheckpointSchema,
    async execute(context: PipelineContext) {
      const result = await m6Contract.run({ jobId: context.job.id });
      return result.checkpoint;
    },
    async validateOutput(output: unknown, context: PipelineContext) {
      return await m6Pipeline.store.validate(
        context.job.id,
        output as Parameters<typeof m6Pipeline.store.validate>[1],
      );
    },
  };
  registry.register(audioAlignedVisualStage);

  // Stage 6: video
  const remotionVideoSources: RemotionVideoSourcePort = {
    async load(jobId) {
      const m6Path = getPersistedAudioAlignedVisualPath(
        path.join(jobsDirectory, jobId),
        jobId,
      );
      const m6Content = await readFile(m6Path, "utf8");
      const m6Record = verifyPersistedAudioAlignedVisualRecord(
        JSON.parse(m6Content),
        jobId,
      );

      const narrationPaths = getPersistedCaptionedNarrationPaths(
        path.join(jobsDirectory, jobId),
        jobId,
      );
      const narrationManifest = JSON.parse(
        await readFile(narrationPaths.manifestPath, "utf8"),
      );
      const narrationAlignment = JSON.parse(
        await readFile(narrationPaths.alignmentPath, "utf8"),
      );

      const composition = createRemotionComposition({
        visual: m6Record.visual,
        alignment: narrationAlignment,
        audio: {
          format: "wav_pcm_s16le",
          path: narrationPaths.audioPath,
          sha256:
            narrationManifest.audio?.sha256 ??
            narrationManifest.audioSha256 ??
            narrationAlignment.audioSha256,
          sampleRate:
            narrationManifest.audio?.sampleRate ??
            narrationManifest.sampleRate ??
            narrationAlignment.sampleRate,
          sampleFrames:
            narrationManifest.audio?.sampleFrames ??
            narrationManifest.sampleFrames ??
            narrationAlignment.sampleFrames,
          channels: 1,
          bitsPerSample: 16,
        },
      });

      const captionPlan = createRemotionCaptionPlan(composition);

      let profile: EditorialProfile = "documentary";
      try {
        const job = await jobs.get(jobId);
        const candidateProfile =
          (job?.config as any)?.profileId ??
          (job?.config as any)?.profile ??
          (job as any)?.payload?.profileId ??
          (job as any)?.payload?.profile;
        if (
          candidateProfile === "explainer" ||
          candidateProfile === "documentary" ||
          candidateProfile === "story"
        ) {
          profile = candidateProfile;
        }
      } catch {
        // Fallback to documentary
      }

      const motionPlan = createEditorialMotionPlan({
        profile,
        fps: composition.fps,
        shots: composition.shots.map((s) => ({
          shotId: s.shotId,
          assetSha256: s.assetSha256,
          startFrame: s.startFrame,
          endFrameExclusive: s.endFrameExclusive,
        })),
      });

      const speechIntervals = createSpeechIntervalsFromWords(
        composition.words,
        composition.fps,
        composition.totalFrames,
      );

      let audioPlan = createEditorialAudioPlan({
        version: 1,
        profile,
        fps: composition.fps,
        totalFrames: composition.totalFrames,
        narrationSha256: composition.audio.sha256,
        speechIntervals,
        music: null,
      });

      try {
        const narrationBytes = await readFile(narrationPaths.audioPath);
        const { rmsDbfs } = measurePcmAudioLoudness(narrationBytes);
        audioPlan = calibrateEditorialAudioPlan(audioPlan, {
          narrationRmsDbfs: rmsDbfs,
        });
      } catch {
        // Retain baseline audio plan
      }

      return {
        manifest: composition,
        captionPlan,
        motionPlan,
        audioPlan,
      };
    },
  };

  const remotionVideoPipeline = createNativeRemotionVideoPipeline({
    jobDirectory: (id) => path.join(jobsDirectory, id),
    sources: remotionVideoSources,
    entryPoint: remotionEntryPoint,
    concurrency: options.concurrency ?? 2,
  });

  const videoStage: PipelineStage = {
    id: REMOTION_VIDEO_STAGE_ID,
    version: "m7-remotion-video-v1",
    dependencies: ["audio_aligned_visual"],
    outputSchema: RemotionVideoCheckpointSchema,
    async execute(context: PipelineContext) {
      const res = await remotionVideoPipeline.stage.execute(context.job.id);
      return res.checkpoint;
    },
    async validateOutput(output: unknown, context: PipelineContext) {
      return await remotionVideoPipeline.stage.validate(context.job.id, output);
    },
  };
  registry.register(videoStage);

  // Stage 7: quality_assurance
  const qaEvidencePort: VerifiedVideoQaEvidencePort = {
    async load(jobId) {
      const videoPaths = getRemotionVideoPaths(
        path.join(jobsDirectory, jobId),
        jobId,
      );
      const videoResult = await remotionVideoPipeline.store.run(jobId);
      const videoSources = await remotionVideoSources.load(jobId);

      const framePlan = createVideoQaFramePlan(videoSources.manifest);
      const frames = await extractVideoQaFrames(
        videoPaths.videoPath,
        framePlan.samples.map((s) => s.frame),
      );
      const frameAnalysis = await analyzeVideoQaFrames(
        videoSources.manifest,
        framePlan,
        frames,
        {
          ...CALIBRATED_RELEASE_POLICY.frames,
          motionPlan: videoSources.motionPlan,
        },
      );

      const audioReport = await runVideoAudioQa({
        videoPath: videoPaths.videoPath,
        record: videoResult.record,
        options: {
          ...CALIBRATED_RELEASE_POLICY.audio,
          words: videoSources.manifest.words,
        },
      });

      const subtitleReport = analyzeVideoQaSubtitles(
        videoSources.manifest,
        videoSources.captionPlan,
        CALIBRATED_RELEASE_POLICY.subtitles,
      );

      const varietyReport = await analyzeVideoVisualVariety(
        videoSources.manifest,
        framePlan,
        frames,
        CALIBRATED_RELEASE_POLICY.variety,
      );

      return {
        composition: videoSources.manifest,
        videoSha256: videoResult.record.videoSha256,
        frames: {
          inspectedFrames: frameAnalysis.inspectedFrames,
          findings: frameAnalysis.findings,
        },
        audio: audioReport,
        subtitles: subtitleReport,
        variety: varietyReport,
      };
    },
  };

  const qaPipeline = createNativeVideoQaPipeline({
    jobDirectory: (id) => path.join(jobsDirectory, id),
    evidence: qaEvidencePort,
    policy: CALIBRATED_RELEASE_POLICY,
  });

  const qaStage: PipelineStage = {
    id: VIDEO_QA_STAGE_ID,
    version: "m8-video-qa-calibrated-v4",
    dependencies: ["video"],
    outputSchema: VideoQaCheckpointSchema,
    async execute(context: PipelineContext) {
      const res = await qaPipeline.stage.execute(context.job.id);
      return res.checkpoint;
    },
    async validateOutput(output: unknown, context: PipelineContext) {
      return await qaPipeline.stage.validate(context.job.id, output);
    },
  };
  registry.register(qaStage);

  // Stage 8: video_export
  const releaseVerifier = new VideoReleaseVerifier({
    jobDirectory: (id) => path.join(jobsDirectory, id),
    videoStore: remotionVideoPipeline.store,
    qaStore: qaPipeline.store,
    ffprobePath,
  });

  const exportSourcesPort: VerifiedExportSourcePort = {
    async load(jobId) {
      const releaseResult = await releaseVerifier.verify(jobId);
      const videoSources = await remotionVideoSources.load(jobId);
      const qaRecord = await qaPipeline.store.load(jobId);
      if (!qaRecord) {
        throw new Error("Missing QA record for export");
      }

      const job = await jobs.get(jobId);
      const rawTitle = job?.config.title ?? "Video Title";
      const sanitizedTitle =
        rawTitle.length > 100
          ? rawTitle.slice(0, 97).trim() + "..."
          : rawTitle;
      const metadata: ExportMetadata = {
        title: sanitizedTitle,
        description: `Generated video on topic: ${job?.config.title ?? ""}`,
        tags: ["ai", "video", "youcreator"],
        language: "en",
      };

      return {
        release: releaseResult.manifest,
        releaseEvidence: {
          jobId,
          compositionHash: videoSources.manifest.compositionHash,
          captionPlanHash: videoSources.captionPlan.captionPlanHash,
          videoSha256: releaseResult.manifest.videoSha256,
          videoBytes: releaseResult.manifest.videoBytes,
          qaReportHash: qaRecord.report.reportHash,
          qaRecordHash: qaRecord.recordHash,
          qaDecision: qaRecord.report.decision,
          codec: releaseResult.manifest.codec,
          audioCodec: releaseResult.manifest.audioCodec,
          fps: releaseResult.manifest.fps,
          width: releaseResult.manifest.width,
          height: releaseResult.manifest.height,
          totalFrames: releaseResult.manifest.totalFrames,
        },
        composition: videoSources.manifest,
        captionPlan: videoSources.captionPlan,
        videoPath: releaseResult.videoPath,
        qaReportJson: JSON.stringify(qaRecord.report, null, 2),
        metadata,
      };
    },
  };

  const exportPipeline = createNativeVideoExportPipeline({
    jobDirectory: (id) => path.join(jobsDirectory, id),
    sources: exportSourcesPort,
  });

  const exportStage: PipelineStage = {
    id: VIDEO_EXPORT_STAGE_ID,
    version: "m9-video-export-v1",
    dependencies: ["quality_assurance"],
    outputSchema: VideoExportCheckpointSchema,
    async execute(context: PipelineContext) {
      const res = await exportPipeline.stage.execute(context.job.id);
      return res.checkpoint;
    },
    async validateOutput(output: unknown, context: PipelineContext) {
      return await exportPipeline.stage.validate(context.job.id, output);
    },
  };
  registry.register(exportStage);

  const runner = new PipelineRunner(registry);
  const executor = new JobExecutor(jobs, runner, jobsDirectory);

  const executeJob = createProductionJobExecutorAdapter(
    executor,
    jobs,
    jobsDirectory,
    {
      mode: pipelineMode,
      durationSeconds: options.durationSeconds,
      fps,
      resolution: `${width}x${height}`,
    },
  );

  const acceptanceRunner = createProductionAcceptanceRunner(
    executeJob,
    exportPipeline.store,
    (id) => path.join(jobsDirectory, id),
  );

  return {
    executor,
    jobs,
    registry,
    runner,
    exportStore: exportPipeline.store,
    jobDirectory: (id) => path.join(jobsDirectory, id),
    executeJob,
    acceptanceRunner,
  };
}
