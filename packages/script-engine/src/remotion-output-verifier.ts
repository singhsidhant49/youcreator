import {
  getVideoMetadata,
} from "@remotion/renderer";

export interface ExpectedRenderedVideo {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
}

export interface RenderedVideoMetadata {
  width: number;
  height: number;
  fps: number;
  durationInSeconds: number | null;
  codec: string;
  audioCodec: string | null;
}

/**
 * Codec, dimensions, FPS and duration checks.
 *
 * Duration permits container timestamp rounding
 * of at most one frame. A later ffprobe frame-count
 * integration can enforce exact encoded frame count.
 */
export function assertRenderedVideoMetadata(
  actual: RenderedVideoMetadata,
  expected: ExpectedRenderedVideo,
): void {
  if (
    actual.codec !== "h264" ||
    actual.audioCodec !== "aac"
  ) {
    throw new Error(
      "M7 output codec mismatch: expected H.264/AAC",
    );
  }

  if (
    actual.width !== expected.width ||
    actual.height !== expected.height
  ) {
    throw new Error(
      "M7 output resolution mismatch",
    );
  }

  if (
    !Number.isFinite(actual.fps) ||
    Math.abs(actual.fps - expected.fps) > 0.001
  ) {
    throw new Error(
      "M7 output FPS mismatch",
    );
  }

  const expectedDuration =
    expected.totalFrames / expected.fps;

  const tolerance = 1 / expected.fps;

  if (
    actual.durationInSeconds === null ||
    !Number.isFinite(actual.durationInSeconds) ||
    Math.abs(
      actual.durationInSeconds -
        expectedDuration,
    ) > tolerance
  ) {
    throw new Error(
      "M7 output duration mismatch",
    );
  }
}

export async function verifyRenderedMp4(
  outputPath: string,
  expected: ExpectedRenderedVideo,
): Promise<RenderedVideoMetadata> {
  const actual: RenderedVideoMetadata =
    await getVideoMetadata(outputPath);

  assertRenderedVideoMetadata(
    actual,
    expected,
  );

  return actual;
}
