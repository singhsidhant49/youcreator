import {
  describe,
  expect,
  it,
} from "vitest";

import {
  analyzePcm16Audio,
} from "./remotion-encoded-media-acceptance.js";

function pcm16(
  samples: readonly number[],
): Buffer {
  const bytes = Buffer.alloc(
    samples.length * 2,
  );

  samples.forEach((sample, index) => {
    bytes.writeInt16LE(
      sample,
      index * 2,
    );
  });

  return bytes;
}

describe("M7.7 decoded audio acceptance", () => {
  it("detects completely silent narration", () => {
    const result = analyzePcm16Audio(
      pcm16([0, 0, 0, 0]),
    );

    expect(result.samples).toBe(4);
    expect(result.peak).toBe(0);
    expect(result.rms).toBe(0);
  });

  it("detects a non-silent audio signal", () => {
    const result = analyzePcm16Audio(
      pcm16([0, 16384, -16384, 0]),
    );

    expect(result.samples).toBe(4);
    expect(result.peak).toBe(0.5);
    expect(result.rms).toBeGreaterThan(0.3);
  });

  it("handles maximum positive PCM16 amplitude", () => {
    const result = analyzePcm16Audio(
      pcm16([32767]),
    );

    expect(result.peak).toBeCloseTo(
      32767 / 32768,
    );
  });

  it("handles minimum negative PCM16 amplitude", () => {
    const result = analyzePcm16Audio(
      pcm16([-32768]),
    );

    expect(result.peak).toBe(1);
    expect(result.rms).toBe(1);
  });

  it("rejects empty decoded audio", () => {
    expect(() =>
      analyzePcm16Audio(Buffer.alloc(0)),
    ).toThrow(
      "M7 decoded PCM16 audio is invalid",
    );
  });

  it("rejects incomplete sample bytes", () => {
    expect(() =>
      analyzePcm16Audio(
        Buffer.from([0x01]),
      ),
    ).toThrow(
      "M7 decoded PCM16 audio is invalid",
    );
  });
});
