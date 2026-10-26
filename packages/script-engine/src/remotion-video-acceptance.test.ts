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
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";

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
  PersistentRemotionVideoStore,
  RemotionVideoCheckpointSchema,
  getRemotionVideoPaths,
} from "./persistent-remotion-video.js";

import {
  createNativeRemotionVideoStage,
  REMOTION_VIDEO_STAGE_ID,
} from "./remotion-video-stage.js";

import {
  createRemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import {
  acceptEncodedRemotionMp4,
} from "./remotion-encoded-media-acceptance.js";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

const H = "a".repeat(64);

function createComposition(jobId: string): RemotionComposition {
  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId,
    productionPackageHash: H,
    m6VisualHash: H,
    visualPackageHash: H,
    framePlanHash: H,
    scriptHash: H,
    alignmentHash: H,
    audioSha256: H,
    compositionHash: H,
    fps: 30,
    width: 1920,
    height: 1080,
    totalFrames: 30,
    shotCount: 1,
    audio: {
      format: "wav_pcm_s16le",
      path: "/tmp/narration.wav",
      sha256: H,
      sampleRate: 24000,
      sampleFrames: 24000,
      channels: 1,
      bitsPerSample: 16,
    },
    shots: [
      {
        version: 1,
        shotId: "shot-1",
        shotIndex: 0,
        bindingHash: H,
        assetSha256: H,
        assetId: "image-1",
        assetPath: "/tmp/image.png",
        sourceWidth: 1920,
        sourceHeight: 1080,
        startFrame: 0,
        endFrameExclusive: 30,
        durationFrames: 30,
        fit: "contain",
        motion: "static",
        startCrop: null,
        endCrop: null,
      },
    ],
    words: [
      {
        tokenIndex: 0,
        index: 0,
        word: "Hello",
        text: "Hello",
        startSample: 0,
        endSampleExclusive: 12000,
        startSeconds: 0,
        endSeconds: 0.5,
      },
    ],
  };
}

const spawnMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: any[]) => spawnMock(...args),
  };
});

function mockChildProcessSpawn(pcmSamples: number[] = [0, 16384, -16384, 0]) {
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    emitter.kill = vi.fn();

    process.nextTick(() => {
      if (args.includes("-show_entries")) {
        const ffprobeJson = JSON.stringify({
          streams: [
            {
              codec_name: "h264",
              codec_type: "video",
              width: 1920,
              height: 1080,
              r_frame_rate: "30/1",
              nb_frames: "30",
            },
            {
              codec_name: "aac",
              codec_type: "audio",
            },
          ],
        });
        emitter.stdout.emit("data", Buffer.from(ffprobeJson, "utf8"));
      } else if (args.includes("-f") && args.includes("s16le")) {
        const pcmBuffer = Buffer.alloc(pcmSamples.length * 2);
        pcmSamples.forEach((sample, i) =>
          pcmBuffer.writeInt16LE(sample, i * 2),
        );
        emitter.stdout.emit("data", pcmBuffer);
      }
      emitter.emit("close", 0);
    });

    return emitter;
  });
}

describe("M7 real M1 execution acceptance", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
    rootDir = undefined;
  });

  async function setupAcceptance() {
    rootDir = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-m7-native-acceptance-"),
    );

    const jobsDir = path.join(rootDir, "jobs");
    const outputDir = path.join(rootDir, "output");

    const jobs = new JobStore(jobsDir);
    let compositionOverride: Partial<RemotionComposition> = {};
    let renderCount = 0;

    const jobDirectory = (jobId: string) => path.join(outputDir, jobId);

    const store = new PersistentRemotionVideoStore({
      jobDirectory,
      sources: {
        async load(jobId: string) {
          const manifest: RemotionComposition = {
            ...createComposition(jobId),
            ...compositionOverride,
            jobId,
          };
          return {
            manifest,
            captionPlan: createRemotionCaptionPlan(manifest),
          };
        },
      },
      renderer: {
        async render({ outputPath }: { outputPath: string }) {
          renderCount += 1;
          await writeFile(outputPath, Buffer.from("production-video-mp4-bytes"), {
            flag: "wx",
          });
        },
      },
      verifier: {
        async verify() {},
      },
    });

    const nativeStage = createNativeRemotionVideoStage(store);

    const videoPipelineStage: PipelineStage = {
      id: REMOTION_VIDEO_STAGE_ID,
      version: "m7-remotion-video-v1",
      dependencies: [],
      outputSchema: RemotionVideoCheckpointSchema,
      async execute(context: PipelineContext) {
        const res = await nativeStage.execute(context.job.id);
        return res.checkpoint;
      },
      async validateOutput(output: unknown, context: PipelineContext) {
        return await nativeStage.validate(context.job.id, output);
      },
    };

    function createExecutor() {
      const registry = new PipelineRegistry();
      registry.register(videoPipelineStage);
      const runner = new PipelineRunner(registry);
      const executor = new JobExecutor(jobs, runner, outputDir);

      return {
        async execute(jobId: string) {
          const result = await executor.execute(jobId);
          if (result.status === "failed") {
            const failedStage = result.stageRuns.find(
              (s) => s.status === "failed",
            );
            throw new Error(
              failedStage?.error ?? "Pipeline execution failed",
            );
          }
          return result;
        },
      };
    }

    async function createJob(scenario: string) {
      return jobs.create({
        title: `M7 Acceptance ${scenario}`,
        mode: "B",
        durationSeconds: 30,
        resolution: "1920x1080",
        fps: 30,
      });
    }

    async function resetJobToQueued(jobId: string) {
      const jobPath = path.join(jobsDir, `${jobId}.json`);
      const raw = await readFile(jobPath, "utf8");
      const jobData = JSON.parse(raw);
      jobData.status = "queued";
      delete jobData.error;
      await writeFile(jobPath, JSON.stringify(jobData, null, 2), "utf8");
    }

    return {
      jobs,
      outputDir,
      store,
      jobDirectory,
      createJob,
      resetJobToQueued,
      getRenderCount: () => renderCount,
      createExecutor,
      getPaths: (jobId: string) =>
        getRemotionVideoPaths(jobDirectory(jobId), jobId),
      invalidateComposition: () => {
        compositionOverride = {
          compositionHash: "f".repeat(64),
        };
      },
    };
  }

  it("executes full production run through real M1 JobExecutor and persists video checkpoint", async () => {
    const fixture = await setupAcceptance();
    const executor = fixture.createExecutor();
    const job = await fixture.createJob("fresh");

    const runResult = await executor.execute(job.id);
    expect(runResult.status).toBe("completed");
    expect(fixture.getRenderCount()).toBe(1);

    const checkpoints = new CheckpointStore(
      fixture.jobDirectory(job.id),
    );
    const cp = await checkpoints.load(REMOTION_VIDEO_STAGE_ID);
    expect(cp).toBeTruthy();
    const checkpoint = RemotionVideoCheckpointSchema.parse(cp?.output);
    expect(checkpoint.jobId).toBe(job.id);
    expect(checkpoint.videoSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("performs independent encoded-media acceptance on committed MP4 with non-silent audio", async () => {
    const fixture = await setupAcceptance();
    const executor = fixture.createExecutor();
    const job = await fixture.createJob("encoded-acceptance");

    await executor.execute(job.id);

    const checkpoints = new CheckpointStore(
      fixture.jobDirectory(job.id),
    );
    const cp = await checkpoints.load(REMOTION_VIDEO_STAGE_ID);
    expect(cp).toBeTruthy();
    const checkpoint = RemotionVideoCheckpointSchema.parse(cp?.output);

    const paths = fixture.getPaths(job.id);

    mockChildProcessSpawn([0, 16384, -16384, 0]);

    const accepted = await acceptEncodedRemotionMp4(paths.videoPath, {
      width: 1920,
      height: 1080,
      fps: 30,
      totalFrames: 30,
      videoSha256: checkpoint.videoSha256,
    });

    expect(accepted.decodedFrames).toBe(30);
    expect(accepted.hasAudibleSignal).toBe(true);
    expect(accepted.audioPeak).toBe(0.5);
    expect(accepted.audioRms).toBeGreaterThan(0.3);
  });

  it("reuses verified video output after restart without unnecessary rendering", async () => {
    const fixture = await setupAcceptance();
    const firstExecutor = fixture.createExecutor();
    const job = await fixture.createJob("restart-reuse");

    await firstExecutor.execute(job.id);
    expect(fixture.getRenderCount()).toBe(1);

    await fixture.resetJobToQueued(job.id);

    const restartedExecutor = fixture.createExecutor();
    const rerunResult = await restartedExecutor.execute(job.id);

    expect(rerunResult.status).toBe("completed");
    expect(fixture.getRenderCount()).toBe(1);
  });

  it("recovers a missing video checkpoint without re-rendering", async () => {
    const fixture = await setupAcceptance();
    const firstExecutor = fixture.createExecutor();
    const job = await fixture.createJob("checkpoint-recovery");

    await firstExecutor.execute(job.id);
    expect(fixture.getRenderCount()).toBe(1);

    const checkpointFile = path.join(
      fixture.jobDirectory(job.id),
      "checkpoints",
      `${REMOTION_VIDEO_STAGE_ID}.json`,
    );
    await rm(checkpointFile, { force: true });

    await fixture.resetJobToQueued(job.id);

    const recoveryExecutor = fixture.createExecutor();
    const recoveryResult = await recoveryExecutor.execute(job.id);

    expect(recoveryResult.status).toBe("completed");
    expect(fixture.getRenderCount()).toBe(1);

    const checkpoints = new CheckpointStore(
      fixture.jobDirectory(job.id),
    );
    const restoredCp = await checkpoints.load(REMOTION_VIDEO_STAGE_ID);
    expect(restoredCp).toBeTruthy();
    const checkpoint = RemotionVideoCheckpointSchema.parse(restoredCp?.output);
    expect(checkpoint.jobId).toBe(job.id);
  });

  it("rejects corrupted immutable MP4 output upon restart", async () => {
    const fixture = await setupAcceptance();
    const firstExecutor = fixture.createExecutor();
    const job = await fixture.createJob("corruption-rejection");

    await firstExecutor.execute(job.id);

    const paths = fixture.getPaths(job.id);
    await writeFile(paths.videoPath, Buffer.from("tampered-mp4-bytes"));

    await fixture.resetJobToQueued(job.id);

    const restartedExecutor = fixture.createExecutor();
    await expect(restartedExecutor.execute(job.id)).rejects.toThrow();
  });

  it("invalidates video reuse when upstream composition changes", async () => {
    const fixture = await setupAcceptance();
    const firstExecutor = fixture.createExecutor();
    const job = await fixture.createJob("upstream-invalidation");

    await firstExecutor.execute(job.id);
    expect(fixture.getRenderCount()).toBe(1);

    fixture.invalidateComposition();
    await fixture.resetJobToQueued(job.id);

    const secondExecutor = fixture.createExecutor();
    await expect(secondExecutor.execute(job.id)).rejects.toThrow();
  });
});
