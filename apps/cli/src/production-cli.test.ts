import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  JobStore,
  CheckpointStore,
  PipelineRegistry,
  PipelineRunner,
  JobExecutor,
  inputHash,
} from "@youcreator/core";

import {
  resolveCanonicalVisualMode,
  type VideoJob,
} from "@youcreator/contracts";

import {
  exportSha256,
} from "@youcreator/script-engine";

import { parseCliArgs, parseResolution } from "./cli-parser.js";
import {
  handleCreate,
  handleStatus,
  handleCancel,
  handleExport,
  handleResume,
  classifyCliError,
  ExitCodes,
  CliError,
} from "./cli-commands.js";

describe("Production CLI & Configuration Binding (M10.7)", () => {
  const testRoot = path.resolve("output/test-cli");
  const jobsDir = path.join(testRoot, "jobs");
  let store: JobStore;

  beforeEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(jobsDir, { recursive: true });
    store = new JobStore(jobsDir);
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  // 1. CLI creation and input validation
  describe("1. CLI Creation and Input Validation", () => {
    it("parses CLI arguments correctly", () => {
      const parsed = parseCliArgs([
        "create",
        "--prompt", "The Rise of Artificial Intelligence",
        "--mode", "ai",
        "--duration", "120",
        "--aspect-ratio", "16:9",
        "--resolution", "1080p",
        "--fps", "30",
        "--profile", "documentary",
      ]);

      expect(parsed.command).toBe("create");
      expect(parsed.options.prompt).toBe("The Rise of Artificial Intelligence");
      expect(parsed.options.canonicalMode).toBe("B");
      expect(parsed.options.duration).toBe(120);
      expect(parsed.options.aspectRatio).toBe("16:9");
      expect(parsed.options.resolution).toBe("1920x1080");
      expect(parsed.options.fps).toBe(30);
      expect(parsed.options.profile).toBe("documentary");
    });

    it("rejects creation when prompt is missing", async () => {
      await expect(
        handleCreate({ mode: "ai", duration: 60 }, store),
      ).rejects.toThrow("Missing required parameter: --prompt");
    });

    it("rejects creation when mode is missing", async () => {
      await expect(
        handleCreate({ prompt: "Coffee History", duration: 60 }, store),
      ).rejects.toThrow("Missing required parameter: --mode");
    });

    it("rejects creation when mode is invalid", async () => {
      await expect(
        handleCreate({ prompt: "Coffee History", mode: "invalid-mode", duration: 60 }, store),
      ).rejects.toThrow('Invalid visual mode: "invalid-mode"');
    });

    it("rejects creation when duration is negative or zero", async () => {
      await expect(
        handleCreate({ prompt: "Coffee History", mode: "ai", duration: -10 }, store),
      ).rejects.toThrow("Missing or invalid required parameter: --duration");
    });
  });

  // 2. Successful run invocation with created job
  describe("2. Successful Run Invocation", () => {
    it("creates and registers a queued job ready for pipeline run", async () => {
      const job = await handleCreate(
        {
          prompt: "Deep Sea Exploration",
          mode: "stock",
          duration: 45,
          resolution: "1080p",
          outputRoot: testRoot,
        },
        store,
      );

      expect(job.id).toBeDefined();
      expect(job.status).toBe("queued");
      expect(job.config.canonicalMode).toBe("A");
      expect(job.config.durationSeconds).toBe(45);
      expect(job.config.resolution).toBe("1920x1080");

      const loaded = await store.get(job.id);
      expect(loaded).toBeDefined();
      expect(loaded?.status).toBe("queued");
    });

    it("auto-creates and sets up job when run command receives topic and mode", async () => {
      const created = await handleCreate(
        {
          topic: "The Engineering of Modern Submarines",
          mode: "stock",
          duration: 60,
          outputRoot: testRoot,
        },
        store,
      );

      expect(created.id).toBeDefined();
      expect(created.config.title).toBe("The Engineering of Modern Submarines");
      expect(created.config.canonicalMode).toBe("A");
      expect(created.config.durationSeconds).toBe(60);
    });
  });


  // 3. Resume with valid checkpoints
  describe("3. Resume with Valid Checkpoints", () => {
    it("recovers an interrupted job and re-queues it for resumption", async () => {
      const job = await store.create({
        version: 2,
        title: "Interrupted Job",
        mode: "B",
        durationSeconds: 60,
      });

      await store.update(job.id, { status: "running" });

      const registry = new PipelineRegistry();
      const runner = new PipelineRunner(registry);
      const executor = new JobExecutor(store, runner, jobsDir);

      await executor.recoverInterrupted(job.id);
      const recovered = await store.get(job.id);
      expect(recovered?.status).toBe("failed");
      expect(recovered?.error).toContain("retry required");

      await executor.retry(job.id);
      const retried = await store.get(job.id);
      expect(retried?.status).toBe("queued");
      expect(retried?.error).toBeUndefined();
    });
  });

  // 4. Missing-job handling
  describe("4. Missing-job Handling", () => {
    it("throws a CliError with code 1 for non-existent job", async () => {
      try {
        await handleStatus("non-existent-uuid", { outputRoot: testRoot }, store);
        expect.unreachable();
      } catch (err) {
        const classified = classifyCliError(err);
        expect(classified.exitCode).toBe(ExitCodes.INVALID_INPUT);
        expect(classified.category).toBe("INVALID_INPUT");
        expect(classified.message).toContain("Job not found: non-existent-uuid");
      }
    });
  });

  // 5. Invalid transition handling
  describe("5. Invalid Transition Handling", () => {
    it("cannot cancel an already completed job", async () => {
      const job = await store.create({
        version: 2,
        title: "Completed Video",
        mode: "A",
        durationSeconds: 45,
      });

      await store.update(job.id, { status: "running" });
      await store.update(job.id, { status: "completed" });

      try {
        await handleCancel(job.id, { outputRoot: testRoot }, store);
        expect.unreachable();
      } catch (err) {
        const classified = classifyCliError(err);
        expect(classified.exitCode).toBe(ExitCodes.INVALID_INPUT);
        expect(classified.message).toContain("Cannot cancel job with status 'completed'");
      }
    });
  });

  // 6. Cancellation semantics
  describe("6. Cancellation", () => {
    it("cancels a queued job and marks it cancelled", async () => {
      const job = await store.create({
        version: 2,
        title: "To Be Cancelled",
        mode: "B",
        durationSeconds: 60,
      });

      const cancelled = await handleCancel(job.id, { outputRoot: testRoot }, store);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.error).toContain("Cancelled by user");

      const inStore = await store.get(job.id);
      expect(inStore?.status).toBe("cancelled");
    });
  });

  // 7. Export verification
  describe("7. Export Verification", () => {
    it("verifies valid export package and rejects corrupted artifacts", async () => {
      const job = await store.create({
        version: 2,
        title: "Export Test Video",
        mode: "A",
        durationSeconds: 30,
      });

      const jobDir = path.join(jobsDir, job.id);
      const exportDir = path.join(jobDir, "export");
      await mkdir(exportDir, { recursive: true });

      const videoContent = Buffer.from("dummy mp4 video binary stream content 12345");
      const videoSha256 = exportSha256(videoContent);
      await writeFile(path.join(exportDir, "video.mp4"), videoContent);

      const metadataContent = Buffer.from(JSON.stringify({ title: "Export Test Video" }));
      const metadataSha256 = exportSha256(metadataContent);
      await writeFile(path.join(exportDir, "metadata.json"), metadataContent);

      const qaContent = Buffer.from(JSON.stringify({ decision: "PASS", score: 95 }));
      const qaSha256 = exportSha256(qaContent);
      await writeFile(path.join(exportDir, "qa-report.json"), qaContent);

      const srtContent = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello");
      const srtSha256 = exportSha256(srtContent);
      await writeFile(path.join(exportDir, "subtitles.srt"), srtContent);

      const vttContent = Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello");
      const vttSha256 = exportSha256(vttContent);
      await writeFile(path.join(exportDir, "subtitles.vtt"), vttContent);

      const manifest = {
        version: 1 as const,
        jobId: job.id,
        releaseHash: "a".repeat(64),
        compositionHash: "b".repeat(64),
        captionPlanHash: "c".repeat(64),
        videoSha256,
        qaReportHash: qaSha256,
        metadataHash: metadataSha256,
        fps: 30,
        totalFrames: 900,
        width: 1920,
        height: 1080,
        files: [
          { filename: "video.mp4", sha256: videoSha256, bytes: videoContent.byteLength },
          { filename: "metadata.json", sha256: metadataSha256, bytes: metadataContent.byteLength },
          { filename: "qa-report.json", sha256: qaSha256, bytes: qaContent.byteLength },
          { filename: "subtitles.srt", sha256: srtSha256, bytes: srtContent.byteLength },
          { filename: "subtitles.vtt", sha256: vttSha256, bytes: vttContent.byteLength },
        ],
        exportHash: "d".repeat(64),
      };

      await writeFile(path.join(exportDir, "manifest.json"), JSON.stringify(manifest, null, 2));

      // Verifying valid export
      const verified = await handleExport(job.id, { outputRoot: testRoot }, store);
      expect(verified.jobId).toBe(job.id);
      expect(verified.verifiedFilesCount).toBe(5);

      // Now corrupt video.mp4
      await writeFile(path.join(exportDir, "video.mp4"), Buffer.from("corrupted payload"));
      try {
        await handleExport(job.id, { outputRoot: testRoot }, store);
        expect.unreachable();
      } catch (err) {
        const classified = classifyCliError(err);
        expect(classified.exitCode).toBe(ExitCodes.CORRUPTION);
        expect(classified.category).toBe("CORRUPTION");
      }
    });
  });

  // 8. Full duration propagation
  describe("8. Full Duration Propagation", () => {
    it("propagates requested duration from CLI to job configuration", async () => {
      const job120 = await handleCreate(
        { prompt: "Long documentary", mode: "stock", duration: 120, outputRoot: testRoot },
        store,
      );
      expect(job120.config.durationSeconds).toBe(120);

      const job45 = await handleCreate(
        { prompt: "Short clip", mode: "ai", duration: 45, outputRoot: testRoot },
        store,
      );
      expect(job45.config.durationSeconds).toBe(45);
    });
  });

  // 9. Resolution and aspect-ratio propagation
  describe("9. Resolution and Aspect-Ratio Propagation", () => {
    it("correctly resolves vertical 9:16 and landscape 16:9 resolutions", () => {
      const vertical1080 = parseResolution("1080p", "9:16");
      expect(vertical1080.width).toBe(1080);
      expect(vertical1080.height).toBe(1920);
      expect(vertical1080.resolutionString).toBe("1080x1920");

      const landscape1080 = parseResolution("1080p", "16:9");
      expect(landscape1080.width).toBe(1920);
      expect(landscape1080.height).toBe(1080);
      expect(landscape1080.resolutionString).toBe("1920x1080");

      const landscape720 = parseResolution("720p", "16:9");
      expect(landscape720.width).toBe(1280);
      expect(landscape720.height).toBe(720);
      expect(landscape720.resolutionString).toBe("1280x720");
    });
  });

  // 10. Mode A/B/C routing
  describe("10. Mode A/B/C Routing", () => {
    it("routes aliases stock -> A, ai -> B, manual -> C", async () => {
      const stockJob = await handleCreate(
        { prompt: "Stock Footage", mode: "stock", duration: 60, outputRoot: testRoot },
        store,
      );
      expect(stockJob.config.canonicalMode).toBe("A");
      expect(stockJob.config.mode).toBe("A");

      const aiJob = await handleCreate(
        { prompt: "AI Art", mode: "ai", duration: 60, outputRoot: testRoot },
        store,
      );
      expect(aiJob.config.canonicalMode).toBe("B");
      expect(aiJob.config.mode).toBe("B");

      const manualJob = await handleCreate(
        { prompt: "Manual Media", mode: "manual", duration: 60, outputRoot: testRoot },
        store,
      );
      expect(manualJob.config.canonicalMode).toBe("C");
      expect(manualJob.config.mode).toBe("C");
    });
  });

  // 11. Legacy mode compatibility
  describe("11. Legacy Mode Compatibility", () => {
    it("safely handles unversioned historical strings via LEGACY_MODE_MAP", () => {
      const resolvedLegacyB = resolveCanonicalVisualMode("B");
      expect(resolvedLegacyB.version).toBe(1);
      expect(resolvedLegacyB.isLegacy).toBe(true);
      expect(resolvedLegacyB.canonicalMode).toBe("A"); // Historical B was stock

      const resolvedLegacyC = resolveCanonicalVisualMode("C");
      expect(resolvedLegacyC.version).toBe(1);
      expect(resolvedLegacyC.isLegacy).toBe(true);
      expect(resolvedLegacyC.canonicalMode).toBe("B"); // Historical C was AI
    });
  });

  // 12. Provider failure handling
  describe("12. Provider Failure Handling", () => {
    it("classifies missing API key or network failures as Exit Code 2", () => {
      const err1 = new Error("IDEOGRAM_API_KEY is required to generate images");
      const c1 = classifyCliError(err1);
      expect(c1.exitCode).toBe(ExitCodes.PROVIDER_FAILURE);
      expect(c1.category).toBe("PROVIDER_FAILURE");

      const err2 = new Error("TTS service fetch failed: ECONNREFUSED 192.168.29.39:8880");
      const c2 = classifyCliError(err2);
      expect(c2.exitCode).toBe(ExitCodes.PROVIDER_FAILURE);
    });
  });

  // 13. Budget enforcement
  describe("13. Budget Enforcement", () => {
    it("classifies cost ceiling and budget violations as Exit Code 3", () => {
      const err = new Error("Estimated image cost $0.0400 exceeds maximum permitted $0.0030 (budget ceiling)");
      const c = classifyCliError(err);
      expect(c.exitCode).toBe(ExitCodes.BUDGET_EXCEEDED);
      expect(c.category).toBe("BUDGET_EXCEEDED");
    });
  });

  // 14. QA rejection handling
  describe("14. QA Rejection Handling", () => {
    it("classifies QA release gate blocks as Exit Code 4", () => {
      const err = new Error("M9 publication blocked: REVIEW (threshold 80 not met)");
      const c = classifyCliError(err);
      expect(c.exitCode).toBe(ExitCodes.QA_REJECTION);
      expect(c.category).toBe("QA_REJECTION");
    });
  });

  // 15. Changed-config cache invalidation
  describe("15. Changed-config Cache Invalidation", () => {
    it("computes different input hashes when config properties change", () => {
      const hash1 = inputHash({
        stageId: "script",
        stageVersion: "v1",
        config: { version: 2, durationSeconds: 60, resolution: "1920x1080" },
        dependencies: {},
      });

      const hash2 = inputHash({
        stageId: "script",
        stageVersion: "v1",
        config: { version: 2, durationSeconds: 120, resolution: "1920x1080" },
        dependencies: {},
      });

      const hash3 = inputHash({
        stageId: "script",
        stageVersion: "v1",
        config: { version: 2, durationSeconds: 60, resolution: "1080x1920" },
        dependencies: {},
      });

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash2).not.toBe(hash3);
    });
  });
});
