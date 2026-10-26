import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  JobStore,
  CheckpointStore,
} from "@youcreator/core";

import {
  resolveCanonicalVisualMode,
  type VideoJob,
} from "@youcreator/contracts";

import {
  createProductionPipeline,
  exportSha256,
  VideoExportManifestSchema,
  type VideoExportManifest,
} from "@youcreator/script-engine";

import {
  parseResolution,
  type CliCommandOptions,
} from "./cli-parser.js";

export const ExitCodes = {
  SUCCESS: 0,
  INVALID_INPUT: 1,
  PROVIDER_FAILURE: 2,
  BUDGET_EXCEEDED: 3,
  QA_REJECTION: 4,
  CORRUPTION: 5,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function classifyCliError(error: unknown): { exitCode: ExitCode; message: string; category: string } {
  if (error instanceof CliError) {
    return {
      exitCode: error.exitCode,
      message: error.message,
      category: Object.keys(ExitCodes).find(
        (key) => ExitCodes[key as keyof typeof ExitCodes] === error.exitCode,
      ) ?? "UNKNOWN",
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // 1. Budget Exceeded
  if (
    lower.includes("budget") ||
    lower.includes("cost ceiling") ||
    lower.includes("exceeds maximum permitted") ||
    lower.includes("exceeded budget") ||
    lower.includes("maxcostperjobusd")
  ) {
    return { exitCode: ExitCodes.BUDGET_EXCEEDED, message, category: "BUDGET_EXCEEDED" };
  }

  // 2. QA Rejection
  if (
    lower.includes("publication blocked") ||
    lower.includes("release gate") ||
    (lower.includes("qa") && (lower.includes("fail") || lower.includes("review") || lower.includes("reject")))
  ) {
    return { exitCode: ExitCodes.QA_REJECTION, message, category: "QA_REJECTION" };
  }

  // 3. Corruption
  if (
    lower.includes("corrupt") ||
    lower.includes("hash mismatch") ||
    lower.includes("identity mismatch") ||
    lower.includes("sha mismatch") ||
    lower.includes("sha256 mismatch") ||
    lower.includes("checksum")
  ) {
    return { exitCode: ExitCodes.CORRUPTION, message, category: "CORRUPTION" };
  }

  // 4. Provider Failure
  if (
    lower.includes("api key") ||
    lower.includes("apikey") ||
    lower.includes("401") ||
    lower.includes("402") ||
    lower.includes("403") ||
    lower.includes("429") ||
    lower.includes("unauthorized") ||
    lower.includes("payment required") ||
    lower.includes("quota exceeded") ||
    lower.includes("tts") ||
    lower.includes("kokoro") ||
    lower.includes("pexels") ||
    lower.includes("ideogram") ||
    lower.includes("deepseek") ||
    lower.includes("fetch failed") ||
    lower.includes("econnrefused")
  ) {
    return { exitCode: ExitCodes.PROVIDER_FAILURE, message, category: "PROVIDER_FAILURE" };
  }

  // 5. Invalid Input / Transition / Not Found
  if (
    lower.includes("not found") ||
    lower.includes("usage:") ||
    lower.includes("cannot execute") ||
    lower.includes("cannot retry") ||
    lower.includes("cannot cancel") ||
    lower.includes("invalid") ||
    lower.includes("expected")
  ) {
    return { exitCode: ExitCodes.INVALID_INPUT, message, category: "INVALID_INPUT" };
  }

  return { exitCode: ExitCodes.INVALID_INPUT, message, category: "GENERIC_ERROR" };
}

export function resolveStorageStores(customOutputRoot?: string): {
  outputRoot: string;
  primaryStore: JobStore;
  fallbackStore: JobStore;
} {
  const outputRoot = path.resolve(
    customOutputRoot ?? process.env.YOUCREATOR_OUTPUT_ROOT ?? "output",
  );
  const primaryStore = new JobStore(path.join(outputRoot, "jobs"));
  const fallbackStore = new JobStore(path.resolve("storage/jobs"));
  return { outputRoot, primaryStore, fallbackStore };
}

export async function findJob(
  jobId: string,
  primaryStore: JobStore,
  fallbackStore: JobStore,
): Promise<{ job: VideoJob; store: JobStore } | null> {
  const primary = await primaryStore.get(jobId);
  if (primary) {
    return { job: primary, store: primaryStore };
  }
  const fallback = await fallbackStore.get(jobId);
  if (fallback) {
    return { job: fallback, store: fallbackStore };
  }
  return null;
}

export async function handleCreate(
  options: CliCommandOptions,
  customStore?: JobStore,
): Promise<VideoJob> {
  const prompt = (options.prompt ?? options.topic ?? options.title ?? "").trim();
  if (!prompt) {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      "Missing required parameter: --prompt <string> (or topic/title)",
    );
  }

  if (!options.mode) {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      "Missing required parameter: --mode <stock|ai|manual|A|B|C>",
    );
  }

  let resolvedMode;
  try {
    resolvedMode = resolveCanonicalVisualMode({ version: 2, mode: options.mode });
  } catch (err) {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      `Invalid visual mode: "${options.mode}". Expected "stock" (A), "ai" (B), or "manual" (C).`,
    );
  }

  if (options.duration === undefined || isNaN(options.duration) || options.duration <= 0) {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      "Missing or invalid required parameter: --duration <seconds> (must be a positive number)",
    );
  }

  const resolutionInfo = parseResolution(options.resolution, options.aspectRatio);

  let parsedAssignments: unknown = undefined;
  if (options.assignments) {
    try {
      if (existsSync(options.assignments)) {
        parsedAssignments = JSON.parse(await readFile(options.assignments, "utf8"));
      } else {
        parsedAssignments = JSON.parse(options.assignments);
      }
      if (Array.isArray(parsedAssignments)) {
        parsedAssignments = parsedAssignments.map((a: any, idx: number) => ({
          shotId: a.shotId ?? `shot-${idx + 1}`,
          assetId: a.assetId ?? `manual-asset-${idx + 1}`,
          localPath: a.localPath,
        }));
      }
    } catch (err) {
      throw new CliError(
        ExitCodes.INVALID_INPUT,
        `Invalid assignments JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { outputRoot, primaryStore } = resolveStorageStores(options.outputRoot);
  const store = customStore ?? primaryStore;

  const derivedTitle =
    options.title ??
    (prompt.length > 100
      ? (prompt.split(/[.:\n]/)[0]?.trim() || prompt.slice(0, 97) + "...")
      : prompt);

  const job = await store.create({
    version: 2,
    title: derivedTitle,
    prompt,
    topic: prompt,
    mode: resolvedMode.canonicalMode,
    canonicalMode: resolvedMode.canonicalMode,
    alias: options.mode,
    durationSeconds: options.duration,
    aspectRatio: resolutionInfo.aspectRatio,
    resolution: resolutionInfo.resolutionString,
    fps: options.fps ?? 30,
    profileId: options.profile ?? "documentary",
    profile: options.profile ?? "documentary",
    voice: options.voice,
    voiceSpeed: options.voiceSpeed,
    imageProvider: options.imageProvider ?? (resolvedMode.canonicalMode === "B" ? "ideogram" : undefined),
    imageModel: options.imageModel ?? (resolvedMode.canonicalMode === "B" ? "p-image-ideogram" : undefined),
    imageQuality: options.imageQuality ?? process.env.IDEOGRAM_QUALITY ?? (resolvedMode.canonicalMode === "B" ? "high" : undefined),
    imageResolution: options.imageResolution ?? process.env.IDEOGRAM_RESOLUTION ?? (resolvedMode.canonicalMode === "B" ? "1k" : undefined),
    maxCostPerJobUsd: options.budget,
    maxCostPerImageUsd: options.maxCostPerImage,
    musicEnabled: options.music,
    musicAssetId: options.musicAssetId,
    assignments: parsedAssignments as any,
    styleGuide: options.styleGuide,
  });

  return job;
}

export async function handleRun(
  jobId: string,
  options: CliCommandOptions,
  customStore?: JobStore,
): Promise<{ jobId: string; status: string }> {
  if (!jobId || !jobId.trim()) {
    throw new CliError(ExitCodes.INVALID_INPUT, "Usage: run <job-id>");
  }

  const { outputRoot, primaryStore, fallbackStore } = resolveStorageStores(options.outputRoot);
  const targetStore = customStore ?? primaryStore;
  const match = await findJob(jobId, targetStore, fallbackStore);

  if (!match) {
    throw new CliError(ExitCodes.INVALID_INPUT, `Job not found: ${jobId}`);
  }

  const job = match.job;
  const activeStore = match.store;

  if (job.status === "completed") {
    console.log(`Job ${jobId} is already completed.`);
    return { jobId, status: "completed" };
  }

  if (job.status === "running") {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      `Job ${jobId} is currently running. Use 'resume ${jobId}' to recover and resume.`,
    );
  }

  if (job.status === "failed") {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      `Job ${jobId} has failed (${job.error ?? "unknown"}). Use 'resume ${jobId}' to retry.`,
    );
  }

  if (job.status === "cancelled") {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      `Job ${jobId} was cancelled. Use 'resume ${jobId}' to re-queue.`,
    );
  }

  const resolutionInfo = parseResolution(
    job.config.resolution ?? options.resolution,
    (job.config.aspectRatio ?? options.aspectRatio) as any,
  );

  const system = createProductionPipeline({
    outputRoot,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekModel: process.env.DEEPSEEK_MODEL,
    pexelsApiKey: process.env.PEXELS_API_KEY,
    kokoroUrl: process.env.KOKORO_TTS_URL,
    ideogramApiKey: process.env.IDEOGRAM_API_KEY,
    ideogramModel: job.config.imageModel ?? process.env.IDEOGRAM_MODEL,
    ideogramQuality: (job.config.imageQuality ?? process.env.IDEOGRAM_QUALITY) as any,
    fps: job.config.fps ?? options.fps ?? 30,
    width: resolutionInfo.width,
    height: resolutionInfo.height,
  });

  console.log(`\n============================================================`);
  console.log(`Executing Job: ${jobId}`);
  console.log(`Topic: "${job.config.title}"`);
  console.log(`Mode: Canonical ${job.config.canonicalMode ?? job.config.mode}`);
  console.log(`Duration: ${job.config.durationSeconds}s`);
  console.log(`Resolution: ${resolutionInfo.resolutionString} @ ${job.config.fps ?? 30}fps`);
  console.log(`============================================================\n`);

  const result = await system.executor.execute(jobId, {
    onStageStart(stageId) {
      console.log(`[Stage: ${stageId}] Starting...`);
    },
    onStageComplete(run) {
      const tag = run.status === "skipped" ? "Reused (checkpoint hit)" : "Completed";
      const hashStr = run.inputHash ? `(hash: ${run.inputHash.slice(0, 12)})` : "";
      console.log(`[Stage: ${run.stageId}] ${tag} ${hashStr}`);
    },
  });

  if (result.status === "failed") {
    const failed = result.stageRuns.find((s) => s.status === "failed");
    throw new Error(failed?.error ?? "Pipeline execution failed");
  }

  console.log(`\nJob ${jobId} completed successfully!`);
  return { jobId, status: result.status };
}

export async function handleResume(
  jobId: string,
  options: CliCommandOptions,
  customStore?: JobStore,
): Promise<{ jobId: string; status: string }> {
  if (!jobId || !jobId.trim()) {
    throw new CliError(ExitCodes.INVALID_INPUT, "Usage: resume <job-id>");
  }

  const { outputRoot, primaryStore, fallbackStore } = resolveStorageStores(options.outputRoot);
  const targetStore = customStore ?? primaryStore;
  const match = await findJob(jobId, targetStore, fallbackStore);

  if (!match) {
    throw new CliError(ExitCodes.INVALID_INPUT, `Job not found: ${jobId}`);
  }

  const job = match.job;
  const activeStore = match.store;

  if (job.status === "completed") {
    console.log(`Job ${jobId} is already completed.`);
    return { jobId, status: "completed" };
  }

  const resolutionInfo = parseResolution(
    job.config.resolution ?? options.resolution,
    (job.config.aspectRatio ?? options.aspectRatio) as any,
  );

  const system = createProductionPipeline({
    outputRoot,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekModel: process.env.DEEPSEEK_MODEL,
    pexelsApiKey: process.env.PEXELS_API_KEY,
    kokoroUrl: process.env.KOKORO_TTS_URL,
    ideogramApiKey: process.env.IDEOGRAM_API_KEY,
    ideogramModel: job.config.imageModel ?? process.env.IDEOGRAM_MODEL,
    ideogramQuality: (job.config.imageQuality ?? process.env.IDEOGRAM_QUALITY) as any,
    fps: job.config.fps ?? options.fps ?? 30,
    width: resolutionInfo.width,
    height: resolutionInfo.height,
  });

async function cleanIncompleteAttempts(jobDir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (const sub of ["captioned-narration", "audio-aligned-visual"]) {
    const parentDir = path.join(jobDir, sub);
    try {
      const entries = await fs.readdir(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const attemptDir = path.join(parentDir, entry.name);
          const attemptFile = path.join(attemptDir, "generation-attempt.json");
          const manifestCandidates =
            sub === "captioned-narration"
              ? ["manifest.json", "narration-manifest.json"]
              : ["audio-aligned-visual.json", "visual-manifest.json"];
          try {
            await fs.access(attemptFile);
            let hasManifest = false;
            for (const cand of manifestCandidates) {
              try {
                await fs.access(path.join(attemptDir, cand));
                hasManifest = true;
                break;
              } catch {}
            }
            if (!hasManifest) {
              await fs.rm(attemptDir, { recursive: true, force: true });
            }
          } catch {}
        }
      }
    } catch {}
  }
}

  if (job.status === "running") {
    console.log(`Job ${jobId} was interrupted in 'running' state. Recovering...`);
    await system.executor.recoverInterrupted(jobId);
    await cleanIncompleteAttempts(path.join(outputRoot, "jobs", jobId));
    await system.executor.retry(jobId);
  } else if (job.status === "failed") {
    console.log(`Job ${jobId} failed previously. Resetting to queued state for resume...`);
    await cleanIncompleteAttempts(path.join(outputRoot, "jobs", jobId));
    await system.executor.retry(jobId);
  } else if (job.status === "cancelled") {
    console.log(`Job ${jobId} was cancelled. Re-queuing for execution...`);
    await activeStore.update(jobId, { status: "queued", error: undefined });
  }

  console.log(`\n============================================================`);
  console.log(`Resuming Job: ${jobId}`);
  console.log(`Topic: "${job.config.title}"`);
  console.log(`Mode: Canonical ${job.config.canonicalMode ?? job.config.mode}`);
  console.log(`Duration: ${job.config.durationSeconds}s`);
  console.log(`Resolution: ${resolutionInfo.resolutionString} @ ${job.config.fps ?? 30}fps`);
  console.log(`============================================================\n`);

  const result = await system.executor.execute(jobId, {
    onStageStart(stageId) {
      console.log(`[Stage: ${stageId}] Starting...`);
    },
    onStageComplete(run) {
      const tag = run.status === "skipped" ? "Reused (checkpoint hit)" : "Completed";
      const hashStr = run.inputHash ? `(hash: ${run.inputHash.slice(0, 12)})` : "";
      console.log(`[Stage: ${run.stageId}] ${tag} ${hashStr}`);
    },
  });

  if (result.status === "failed") {
    const failed = result.stageRuns.find((s) => s.status === "failed");
    throw new Error(failed?.error ?? "Pipeline execution failed");
  }

  console.log(`\nJob ${jobId} completed successfully!`);
  return { jobId, status: result.status };
}

export async function handleStatus(
  jobId: string,
  options: CliCommandOptions,
  customStore?: JobStore,
): Promise<Record<string, unknown>> {
  if (!jobId || !jobId.trim()) {
    throw new CliError(ExitCodes.INVALID_INPUT, "Usage: status <job-id>");
  }

  const { outputRoot, primaryStore, fallbackStore } = resolveStorageStores(options.outputRoot);
  const targetStore = customStore ?? primaryStore;
  const match = await findJob(jobId, targetStore, fallbackStore);

  if (!match) {
    throw new CliError(ExitCodes.INVALID_INPUT, `Job not found: ${jobId}`);
  }

  const job = match.job;
  const jobDir = path.join(outputRoot, "jobs", jobId);

  const checkpointStore = new CheckpointStore(jobDir);
  const stages = [
    "script",
    "storyboard",
    "media",
    "visual",
    "audio_aligned_visual",
    "video",
    "quality_assurance",
    "video_export",
  ];

  const checkpointsFound: Record<string, { completedAt: string; inputHash: string }> = {};
  for (const stage of stages) {
    try {
      const cp = await checkpointStore.load(stage as any);
      if (cp) {
        checkpointsFound[stage] = {
          completedAt: cp.completedAt,
          inputHash: cp.inputHash,
        };
      }
    } catch {
      // Ignore
    }
  }

  let qaDecision: string | undefined;
  try {
    const qaReportPath = path.join(jobDir, "quality-assurance", "report.json");
    if (existsSync(qaReportPath)) {
      const qa = JSON.parse(await readFile(qaReportPath, "utf8"));
      qaDecision = qa.decision;
    }
  } catch {
    // Ignore
  }

  let exportDetails: Record<string, unknown> | undefined;
  const exportManifestPath = path.join(jobDir, "export", "manifest.json");
  if (existsSync(exportManifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
      exportDetails = {
        directory: path.join(jobDir, "export"),
        videoSha256: manifest.videoSha256,
        fps: manifest.fps,
        width: manifest.width,
        height: manifest.height,
        durationSeconds: manifest.totalFrames && manifest.fps ? manifest.totalFrames / manifest.fps : undefined,
        qaDecision: manifest.qaDecision,
      };
    } catch {
      // Ignore
    }
  }

  const report = {
    jobId: job.id,
    status: job.status,
    title: job.config.title,
    mode: job.config.canonicalMode ?? job.config.mode,
    durationSeconds: job.config.durationSeconds,
    resolution: job.config.resolution ?? "1920x1080",
    fps: job.config.fps ?? 30,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    checkpoints: checkpointsFound,
    qaDecision,
    export: exportDetails,
  };

  return report;
}

export async function handleCancel(
  jobId: string,
  options: CliCommandOptions,
  customStore?: JobStore,
): Promise<VideoJob> {
  if (!jobId || !jobId.trim()) {
    throw new CliError(ExitCodes.INVALID_INPUT, "Usage: cancel <job-id>");
  }

  const { outputRoot, primaryStore, fallbackStore } = resolveStorageStores(options.outputRoot);
  const targetStore = customStore ?? primaryStore;
  const match = await findJob(jobId, targetStore, fallbackStore);

  if (!match) {
    throw new CliError(ExitCodes.INVALID_INPUT, `Job not found: ${jobId}`);
  }

  const job = match.job;
  const activeStore = match.store;

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      `Cannot cancel job with status '${job.status}'`,
    );
  }

  const updated = await activeStore.update(jobId, {
    status: "cancelled",
    error: "Cancelled by user",
  });

  return updated;
}

export async function handleExport(
  jobId: string,
  options: CliCommandOptions,
  customStore?: JobStore,
): Promise<{
  jobId: string;
  directory: string;
  manifest: VideoExportManifest;
  verifiedFilesCount: number;
}> {
  if (!jobId || !jobId.trim()) {
    throw new CliError(ExitCodes.INVALID_INPUT, "Usage: export <job-id>");
  }

  const { outputRoot, primaryStore, fallbackStore } = resolveStorageStores(options.outputRoot);
  const targetStore = customStore ?? primaryStore;
  const match = await findJob(jobId, targetStore, fallbackStore);

  if (!match) {
    throw new CliError(ExitCodes.INVALID_INPUT, `Job not found: ${jobId}`);
  }

  const jobDir = path.join(outputRoot, "jobs", jobId);
  const exportDir = path.join(jobDir, "export");
  const manifestPath = path.join(exportDir, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new CliError(
      ExitCodes.INVALID_INPUT,
      `Export manifest not found for job ${jobId}. Ensure job has completed stage 'video_export'.`,
    );
  }

  let manifest: VideoExportManifest;
  try {
    const content = await readFile(manifestPath, "utf8");
    manifest = VideoExportManifestSchema.parse(JSON.parse(content));
  } catch (err) {
    throw new CliError(
      ExitCodes.CORRUPTION,
      `Export manifest failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const file of manifest.files) {
    const filePath = path.join(exportDir, file.filename);
    if (!existsSync(filePath)) {
      throw new CliError(
        ExitCodes.CORRUPTION,
        `Export artifact missing from package: ${file.filename}`,
      );
    }

    const fileStat = await stat(filePath);
    if (fileStat.size !== file.bytes) {
      throw new CliError(
        ExitCodes.CORRUPTION,
        `Export artifact size mismatch for ${file.filename}: expected ${file.bytes}, got ${fileStat.size}`,
      );
    }

    const bytes = await readFile(filePath);
    const actualHash = exportSha256(bytes);
    if (actualHash !== file.sha256) {
      throw new CliError(
        ExitCodes.CORRUPTION,
        `Export artifact SHA-256 mismatch for ${file.filename}: expected ${file.sha256}, got ${actualHash}`,
      );
    }
  }

  const videoEntry = manifest.files.find((f) => f.filename === "video.mp4");
  if (!videoEntry || videoEntry.sha256 !== manifest.videoSha256) {
    throw new CliError(
      ExitCodes.CORRUPTION,
      `Exported video.mp4 sha256 does not match manifest.videoSha256`,
    );
  }

  return {
    jobId,
    directory: exportDir,
    manifest,
    verifiedFilesCount: manifest.files.length,
  };
}
