import { spawn } from "node:child_process";
import path from "node:path";
import { getVideoMetadata } from "@remotion/renderer";

export interface ExpectedVideo {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
}

export interface FinalVideoMetadata {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  codec: string;
  audioCodec: string | null;
}

export function assertFinalVideoMetadata(
  actual: FinalVideoMetadata,
  expected: ExpectedVideo,
): void {
  if (actual.codec !== "h264" || actual.audioCodec !== "aac") {
    throw new Error("M7 final video codec mismatch: expected H.264/AAC");
  }

  if (actual.width !== expected.width) {
    throw new Error("M7 final video resolution mismatch");
  }

  if (actual.height !== expected.height) {
    throw new Error("M7 final video resolution mismatch");
  }

  if (!Number.isFinite(actual.fps) || Math.abs(actual.fps - expected.fps) > 0.001) {
    throw new Error("M7 final video FPS mismatch");
  }

  if (
    !Number.isSafeInteger(actual.totalFrames) ||
    actual.totalFrames !== expected.totalFrames
  ) {
    throw new Error("M7 final video frame count mismatch");
  }
}

async function runProcess(
  executable: string,
  args: string[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffprobe failed: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

export async function verifyFinalVideo(
  videoPath: string,
  expected: ExpectedVideo,
  ffprobePath?: string,
): Promise<FinalVideoMetadata> {
  if (!path.isAbsolute(videoPath)) {
    throw new Error("M7 video verification requires absolute path");
  }

  const executable = ffprobePath ?? "ffprobe";

  try {
    const raw = await runProcess(executable, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames",
      "-of",
      "json",
      videoPath,
    ]);

    const parsed = JSON.parse(raw.toString("utf8"));
    const videoStream = parsed.streams?.find(
      (s: any) => s.codec_type === "video",
    );
    const audioStream = parsed.streams?.find(
      (s: any) => s.codec_type === "audio",
    );

    if (!videoStream) {
      throw new Error("M7 missing video stream in MP4");
    }

    const [num, den] = (videoStream.r_frame_rate || "")
      .split("/")
      .map(Number);
    const fps = den ? num / den : Number(videoStream.r_frame_rate);
    const totalFrames = Number(
      videoStream.nb_frames ||
        Math.round(fps * (parsed.format?.duration || 0)),
    );

    const actual: FinalVideoMetadata = {
      width: Number(videoStream.width),
      height: Number(videoStream.height),
      fps,
      totalFrames,
      codec: videoStream.codec_name,
      audioCodec: audioStream?.codec_name ?? null,
    };

    assertFinalVideoMetadata(actual, expected);
    return actual;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("M7 final video")) {
      throw error;
    }

    // If ffprobe binary execution is unavailable, fall back to Remotion's getVideoMetadata
    const remotionMeta = await getVideoMetadata(videoPath);
    const actual: FinalVideoMetadata = {
      width: remotionMeta.width,
      height: remotionMeta.height,
      fps: remotionMeta.fps,
      totalFrames: Math.round(
        remotionMeta.fps * (remotionMeta.durationInSeconds ?? 0),
      ),
      codec: remotionMeta.codec,
      audioCodec: remotionMeta.audioCodec,
    };

    assertFinalVideoMetadata(actual, expected);
    return actual;
  }
}
