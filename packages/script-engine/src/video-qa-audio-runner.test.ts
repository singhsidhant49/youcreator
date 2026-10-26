import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  PersistedRemotionVideo,
} from "./persistent-remotion-video.js";

import {
  runVideoAudioQa,
} from "./video-qa-audio-runner.js";

const H = "a".repeat(64);

function hash(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

describe("M8.3 native audio QA runner", () => {
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
        "youcreator-m8-audio-",
      ),
    );

    const videoPath = path.join(
      directory,
      "final-video.mp4",
    );

    const bytes = Buffer.from(
      "immutable-video-test",
    );

    await writeFile(videoPath, bytes);

    const record: PersistedRemotionVideo = {
      version: 1,
      jobId: "m8-audio-job",
      compositionHash: H,
      captionPlanHash: H,
      videoSha256: hash(bytes),
      videoBytes: bytes.length,
      fps: 30,
      width: 1920,
      height: 1080,
      totalFrames: 30,
      codec: "h264",
      audioCodec: "aac",
      recordHash: H,
    };

    const pcm = Buffer.alloc(
      16000 * 2,
    );

    for (let i = 0; i < 16000; i++) {
      pcm.writeInt16LE(
        Math.round(
          8192 *
          Math.sin(
            i * Math.PI / 16,
          ),
        ),
        i * 2,
      );
    }

    return {
      videoPath,
      record,
      pcm,
    };
  }

  it("analyzes a verified published video", async () => {
    const test = await fixture();

    const decode = vi.fn(
      async () => test.pcm,
    );

    const result = await runVideoAudioQa(
      {
        videoPath: test.videoPath,
        record: test.record,
      },
      { decode },
    );

    expect(result.sampleRate).toBe(16000);
    expect(result.sampleFrames).toBe(16000);
    expect(result.reportHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(decode).toHaveBeenCalledOnce();
  });

  it("rejects modified MP4 before decoding", async () => {
    const test = await fixture();

    await writeFile(
      test.videoPath,
      Buffer.from("corrupted"),
    );

    const decode = vi.fn(
      async () => test.pcm,
    );

    await expect(
      runVideoAudioQa(
        {
          videoPath: test.videoPath,
          record: test.record,
        },
        { decode },
      ),
    ).rejects.toThrow(
      "M8 audio QA MP4 integrity mismatch",
    );

    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects modification during audio decoding", async () => {
    const test = await fixture();

    const decode = vi.fn(async () => {
      await writeFile(
        test.videoPath,
        Buffer.from("modified-during-decode"),
      );

      return test.pcm;
    });

    await expect(
      runVideoAudioQa(
        {
          videoPath: test.videoPath,
          record: test.record,
        },
        { decode },
      ),
    ).rejects.toThrow(
      "M8 audio QA video changed during decoding",
    );
  });

  it("propagates decoder failures", async () => {
    const test = await fixture();

    const decode = vi.fn(
      async (): Promise<Buffer> => {
        throw new Error("FFmpeg failed");
      },
    );

    await expect(
      runVideoAudioQa(
        {
          videoPath: test.videoPath,
          record: test.record,
        },
        { decode },
      ),
    ).rejects.toThrow("FFmpeg failed");
  });
});
