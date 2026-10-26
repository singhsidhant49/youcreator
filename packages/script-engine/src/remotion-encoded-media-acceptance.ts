import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  verifyFinalVideo,
  type ExpectedVideo,
} from "./remotion-ffprobe-verifier.js";

export interface EncodedMediaAcceptanceOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  maxAudioBytes?: number;
}

export interface EncodedMediaAcceptanceResult {
  videoSha256: string;
  videoBytes: number;
  decodedFrames: number;
  expectedFrames: number;
  decodedAudioSamples: number;
  audioPeak: number;
  audioRms: number;
  hasAudibleSignal: boolean;
}

async function runProcess(
  executable: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishError(
        new Error("M7 media decoding timed out"),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;

      if (total > options.maxOutputBytes) {
        child.kill("SIGKILL");
        finishError(
          new Error("M7 decoded output limit exceeded"),
        );
        return;
      }

      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (
        Buffer.concat(stderr).length < 64_000
      ) {
        stderr.push(chunk);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finishError(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (settled) return;

      if (code !== 0) {
        finishError(
          new Error(
            `M7 FFmpeg decode failed: ${Buffer.concat(
              stderr,
            ).toString("utf8")}`,
          ),
        );
        return;
      }

      settled = true;
      resolve(Buffer.concat(stdout));
    });
  });
}

export function analyzePcm16Audio(
  bytes: Buffer,
): {
  samples: number;
  peak: number;
  rms: number;
} {
  if (
    bytes.length === 0 ||
    bytes.length % 2 !== 0
  ) {
    throw new Error(
      "M7 decoded PCM16 audio is invalid",
    );
  }

  let peak = 0;
  let sumSquares = 0;

  const samples = bytes.length / 2;

  for (let index = 0; index < samples; index++) {
    const value = bytes.readInt16LE(
      index * 2,
    ) / 32768;

    const magnitude = Math.abs(value);

    peak = Math.max(peak, magnitude);
    sumSquares += value * value;
  }

  return {
    samples,
    peak,
    rms: Math.sqrt(sumSquares / samples),
  };
}

/**
 * Decode the exact video frames to the null muxer.
 *
 * FFprobe counts frames; this operation also
 * verifies that FFmpeg can decode the stream.
 */
export async function verifyVideoDecoding(
  videoPath: string,
  expectedFrames: number,
  options: EncodedMediaAcceptanceOptions = {},
): Promise<void> {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";

  await runProcess(
    ffmpeg,
    [
      "-v", "error",
      "-xerror",
      "-i", videoPath,
      "-map", "0:v:0",
      "-an",
      "-f", "null",
      "-",
    ],
    {
      timeoutMs: options.timeoutMs ?? 120_000,
      maxOutputBytes: 1024,
    },
  );

  if (
    !Number.isSafeInteger(expectedFrames) ||
    expectedFrames < 1
  ) {
    throw new Error(
      "M7 invalid expected frame count",
    );
  }
}

/**
 * Decode AAC to 16-bit mono PCM.
 *
 * A bounded result prevents unexpectedly large
 * audio allocations during acceptance.
 */
export async function decodeMp4Audio(
  videoPath: string,
  options: EncodedMediaAcceptanceOptions = {},
): Promise<Buffer> {
  return runProcess(
    options.ffmpegPath ?? "ffmpeg",
    [
      "-v", "error",
      "-xerror",
      "-i", videoPath,
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-f", "s16le",
      "pipe:1",
    ],
    {
      timeoutMs: options.timeoutMs ?? 120_000,
      maxOutputBytes:
        options.maxAudioBytes ??
        64 * 1024 * 1024,
    },
  );
}

/**
 * Strict final acceptance.
 *
 * The source record SHA is checked separately
 * from the video/audio decode checks.
 */
export async function acceptEncodedRemotionMp4(
  videoPath: string,
  expected: ExpectedVideo & {
    videoSha256: string;
    minimumAudioRms?: number;
  },
  options: EncodedMediaAcceptanceOptions = {},
): Promise<EncodedMediaAcceptanceResult> {
  if (!path.isAbsolute(videoPath)) {
    throw new Error(
      "M7 acceptance requires absolute video path",
    );
  }

  const file = await stat(videoPath);

  if (!file.isFile() || file.size === 0) {
    throw new Error(
      "M7 accepted video must be nonempty",
    );
  }

  const bytes = await readFile(videoPath);

  const videoSha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");

  if (videoSha256 !== expected.videoSha256) {
    throw new Error(
      "M7 accepted video SHA-256 mismatch",
    );
  }

  const metadata = await verifyFinalVideo(
    videoPath,
    expected,
    options.ffprobePath,
  );

  await verifyVideoDecoding(
    videoPath,
    expected.totalFrames,
    options,
  );

  const pcm = await decodeMp4Audio(
    videoPath,
    options,
  );

  const audio = analyzePcm16Audio(pcm);

  const minimumRms =
    expected.minimumAudioRms ?? 0.0001;

  if (
    !Number.isFinite(minimumRms) ||
    minimumRms < 0 ||
    minimumRms >= 1
  ) {
    throw new Error(
      "M7 invalid audio RMS threshold",
    );
  }

  if (audio.rms <= minimumRms) {
    throw new Error(
      "M7 encoded audio is silent or too quiet",
    );
  }

  return {
    videoSha256,
    videoBytes: bytes.length,
    decodedFrames: metadata.totalFrames,
    expectedFrames: expected.totalFrames,
    decodedAudioSamples: audio.samples,
    audioPeak: audio.peak,
    audioRms: audio.rms,
    hasAudibleSignal: true,
  };
}
