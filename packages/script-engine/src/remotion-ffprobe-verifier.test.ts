import {
  describe,
  expect,
  it,
} from "vitest";

import {
  assertFinalVideoMetadata,
  type ExpectedVideo,
  type FinalVideoMetadata,
} from "./remotion-ffprobe-verifier.js";

describe("M7.7 final video ffprobe verification", () => {
  const expected: ExpectedVideo = {
    width: 1920,
    height: 1080,
    fps: 30,
    totalFrames: 90,
  };

  const validMetadata: FinalVideoMetadata = {
    width: 1920,
    height: 1080,
    fps: 30,
    totalFrames: 90,
    codec: "h264",
    audioCodec: "aac",
  };

  it("accepts valid video matching expected metadata", () => {
    expect(() =>
      assertFinalVideoMetadata(validMetadata, expected),
    ).not.toThrow();
  });

  it("rejects wrong video codec", () => {
    expect(() =>
      assertFinalVideoMetadata(
        { ...validMetadata, codec: "vp9" },
        expected,
      ),
    ).toThrow("M7 final video codec mismatch: expected H.264/AAC");
  });

  it("rejects missing audio codec", () => {
    expect(() =>
      assertFinalVideoMetadata(
        { ...validMetadata, audioCodec: null },
        expected,
      ),
    ).toThrow("M7 final video codec mismatch: expected H.264/AAC");
  });

  it("rejects width mismatch", () => {
    expect(() =>
      assertFinalVideoMetadata(
        { ...validMetadata, width: 1280 },
        expected,
      ),
    ).toThrow("M7 final video resolution mismatch");
  });

  it("rejects height mismatch", () => {
    expect(() =>
      assertFinalVideoMetadata(
        { ...validMetadata, height: 720 },
        expected,
      ),
    ).toThrow("M7 final video resolution mismatch");
  });

  it("rejects wrong FPS", () => {
    expect(() =>
      assertFinalVideoMetadata(
        { ...validMetadata, fps: 24 },
        expected,
      ),
    ).toThrow("M7 final video FPS mismatch");
  });

  it("rejects wrong frame count", () => {
    expect(() =>
      assertFinalVideoMetadata(
        { ...validMetadata, totalFrames: 89 },
        expected,
      ),
    ).toThrow("M7 final video frame count mismatch");
  });

  it("rejects invalid non-integer frames", () => {
    expect(() =>
      assertFinalVideoMetadata(
        { ...validMetadata, totalFrames: 89.5 },
        expected,
      ),
    ).toThrow("M7 final video frame count mismatch");
  });
});
