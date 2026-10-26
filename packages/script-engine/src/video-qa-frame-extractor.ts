import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type DecodedQaFrame,
} from "./video-qa-frame-analyzer.js";

export interface QaFrameExtractorOptions {
  ffmpegPath?: string;
  batchSize?: number;
  timeoutMs?: number;
  tempRoot?: string;
}

function validateFrames(
  frames: readonly number[],
): void {
  if (
    frames.length === 0 ||
    frames.some(
      (frame, index) =>
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        (index > 0 && frame <= frames[index - 1]!),
    )
  ) {
    throw new Error(
      "M8 frame extraction requires sorted unique nonnegative frames",
    );
  }
}

function selectExpression(
  frames: readonly number[],
): string {
  return frames
    .map((frame) => `eq(n\\,${frame})`)
    .join("+");
}

async function runFfmpeg(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [...args],
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );

    let stderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(
        new Error("M8 FFmpeg frame extraction timed out"),
      );
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 32_000) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (settled) return;

      if (code !== 0) {
        fail(
          new Error(
            `M8 FFmpeg frame extraction failed: ${stderr}`,
          ),
        );
        return;
      }

      settled = true;
      resolve();
    });
  });
}

export async function extractVideoQaFrames(
  videoPath: string,
  requestedFrames: readonly number[],
  options: QaFrameExtractorOptions = {},
): Promise<DecodedQaFrame[]> {
  if (!path.isAbsolute(videoPath)) {
    throw new Error(
      "M8 frame extraction requires absolute video path",
    );
  }

  validateFrames(requestedFrames);

  const batchSize = options.batchSize ?? 64;
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 256 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error(
      "M8 invalid FFmpeg extraction settings",
    );
  }

  const temporaryDirectory = await mkdtemp(
    path.join(
      options.tempRoot ?? os.tmpdir(),
      "youcreator-qa-frames-",
    ),
  );

  const result: DecodedQaFrame[] = [];

  try {
    for (
      let offset = 0;
      offset < requestedFrames.length;
      offset += batchSize
    ) {
      const batch = requestedFrames.slice(
        offset,
        offset + batchSize,
      );

      const batchDirectory = path.join(
        temporaryDirectory,
        `batch-${offset}`,
      );

      const { mkdir } = await import(
        "node:fs/promises"
      );

      await mkdir(batchDirectory);

      const outputPattern = path.join(
        batchDirectory,
        "frame-%06d.png",
      );

      const baseArgs = [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-xerror",
        "-i", videoPath,
        "-map", "0:v:0",
        "-vf", `select=${selectExpression(batch)}`,
      ];

      const tailArgs = [
        "-frames:v", String(batch.length),
        outputPattern,
      ];

      try {
        await runFfmpeg(
          options.ffmpegPath ?? "ffmpeg",
          [
            ...baseArgs,
            "-fps_mode", "passthrough",
            ...tailArgs,
          ],
          timeoutMs,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("fps_mode")
        ) {
          await runFfmpeg(
            options.ffmpegPath ?? "ffmpeg",
            [
              ...baseArgs,
              "-vsync", "0",
              ...tailArgs,
            ],
            timeoutMs,
          );
        } else {
          throw error;
        }
      }

      const files = (
        await readdir(batchDirectory)
      )
        .filter((name) =>
          /^frame-\d{6}\.png$/.test(name),
        )
        .sort();

      if (files.length !== batch.length) {
        throw new Error(
          `M8 extracted frame count mismatch: expected ${batch.length}, got ${files.length}`,
        );
      }

      for (let index = 0; index < batch.length; index++) {
        result.push({
          frame: batch[index]!,
          png: await readFile(
            path.join(
              batchDirectory,
              files[index]!,
            ),
          ),
        });
      }
    }

    return result;
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}
