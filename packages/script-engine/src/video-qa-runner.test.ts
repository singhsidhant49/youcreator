import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import type {
  PersistedRemotionVideo,
} from "./persistent-remotion-video.js";

import {
  runVideoQa,
  type VideoQaRunnerPorts,
} from "./video-qa-runner.js";

const H = "a".repeat(64);

function sha256(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

function composition(): RemotionComposition {
  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId: "m8-runner-job",
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
    shots: [{
      version: 1,
      shotId: "shot-1",
      shotIndex: 0,
      bindingHash: H,
      assetSha256: H,
      assetId: "asset-1",
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
    }],
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

describe("M8.2 video QA runner", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }

    directory = undefined;
  });

  async function fixture() {
    directory = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m8-qa-",
      ),
    );

    const videoPath = path.join(
      directory,
      "final.mp4",
    );

    const video = Buffer.from(
      "test-video-bytes",
    );

    await writeFile(
      videoPath,
      video,
    );

    const manifest = composition();

    const record = {
      version: 1 as const,
      jobId: manifest.jobId,
      compositionHash:
        manifest.compositionHash,
      captionPlanHash: H,
      videoSha256: sha256(video),
      videoBytes: video.length,
      fps: manifest.fps,
      width: manifest.width,
      height: manifest.height,
      totalFrames: manifest.totalFrames,
      codec: "h264" as const,
      audioCodec: "aac" as const,
      recordHash: H,
    } satisfies PersistedRemotionVideo;

    const png = await sharp({
      create: {
        width: 64,
        height: 36,
        channels: 3,
        background: "#ffffff",
      },
    })
      .png()
      .toBuffer();

    const ports: VideoQaRunnerPorts = {
      extract: vi.fn(async (_path: string, frames: readonly number[]) =>
        frames.map((frame) => ({
          frame,
          png,
        })),
      ),

      verifyVideo: vi.fn(async () => {}),
    };

    return {
      videoPath,
      manifest,
      record,
      ports,
    };
  }

  it("produces a verified deterministic QA report", async () => {
    const test = await fixture();

    const result = await runVideoQa(
      {
        videoPath: test.videoPath,
        composition: test.manifest,
        record: test.record,
      },
      {},
      test.ports,
    );

    expect(result.sampledFrames).toBe(3);
    expect(result.findings).toEqual([]);

    expect(result.reportHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    expect(
      test.ports.verifyVideo,
    ).toHaveBeenCalledOnce();
  });

  it("rejects mismatched upstream identity", async () => {
    const test = await fixture();

    test.record.compositionHash =
      "b".repeat(64);

    await expect(
      runVideoQa(
        {
          videoPath: test.videoPath,
          composition: test.manifest,
          record: test.record,
        },
        {},
        test.ports,
      ),
    ).rejects.toThrow(
      "M8 video QA upstream dependency mismatch",
    );
  });

  it("rejects corrupted video bytes", async () => {
    const test = await fixture();

    await writeFile(
      test.videoPath,
      Buffer.from("modified-video!!"),
    );

    await expect(
      runVideoQa(
        {
          videoPath: test.videoPath,
          composition: test.manifest,
          record: test.record,
        },
        {},
        test.ports,
      ),
    ).rejects.toThrow();
  });

  it("detects black frames from extracted pixels", async () => {
    const test = await fixture();

    const black = await sharp({
      create: {
        width: 64,
        height: 36,
        channels: 3,
        background: "#000000",
      },
    })
      .png()
      .toBuffer();

    test.ports.extract = vi.fn(
      async (_path: string, frames: readonly number[]) =>
        frames.map((frame) => ({
          frame,
          png: black,
        })),
    );

    const report = await runVideoQa(
      {
        videoPath: test.videoPath,
        composition: test.manifest,
        record: test.record,
      },
      {},
      test.ports,
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "BLACK_FRAME",
      ),
    ).toBe(true);
  });

  it("rejects missing extracted frames", async () => {
    const test = await fixture();

    test.ports.extract = vi.fn(
      async () => [],
    );

    await expect(
      runVideoQa(
        {
          videoPath: test.videoPath,
          composition: test.manifest,
          record: test.record,
        },
        {},
        test.ports,
      ),
    ).rejects.toThrow(
      "M8 decoded frame coverage mismatch",
    );
  });
});
