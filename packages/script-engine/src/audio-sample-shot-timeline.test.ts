import { createHash } from "node:crypto";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createNarrationAudio,
} from "./narration-audio-contract.js";

import {
  createNarrationWordAlignment,
} from "./narration-alignment-contract.js";

import {
  createShotNarrationAnchors,
} from "./shot-narration-anchors.js";

import {
  createAudioSampleShotTimeline,
  verifyAudioSampleShotTimeline,
} from "./audio-sample-shot-timeline.js";

const JOB_ID = "job-m6-sample-timeline";
const SCRIPT = "Hello world. This is YouCreator.";

function hash(text: string): string {
  return createHash("sha256")
    .update(text)
    .digest("hex");
}

function wavFixture(): Buffer {
  const frames = 72000;
  const wav = Buffer.alloc(44 + frames * 2);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);

  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);

  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);

  wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);

  return wav;
}

function fixture() {
  const audio = createNarrationAudio(
    JOB_ID,
    wavFixture(),
  );

  const alignment = createNarrationWordAlignment({
    scriptText: SCRIPT,
    audio,
    timestamps: [
      {
        word: "Hello",
        start_time: 0.041,
        end_time: 0.391,
      },
      {
        word: "world",
        start_time: 0.391,
        end_time: 0.966,
      },
      {
        word: ".",
        start_time: 0.966,
        end_time: 1.128,
      },
      {
        word: "This",
        start_time: 1.128,
        end_time: 1.341,
      },
      {
        word: "is",
        start_time: 1.341,
        end_time: 1.491,
      },
      {
        word: "YouCreator",
        start_time: 1.491,
        end_time: 2.541,
      },
      {
        word: ".",
        start_time: 2.541,
        end_time: 2.766,
      },
    ],
  });

  const anchors = createShotNarrationAnchors({
    jobId: JOB_ID,
    productionPackageHash: hash(
      "verified-m3-production",
    ),
    scriptText: SCRIPT,
    alignment,
    shots: [
      {
        shotId: "shot-001",
        shotIndex: 0,
        startTokenIndex: 0,
        endTokenIndexExclusive: 3,
      },
      {
        shotId: "shot-002",
        shotIndex: 1,
        startTokenIndex: 3,
        endTokenIndexExclusive: 7,
      },
    ],
  });

  return {
    anchors,
    authoritativeShotIds: [
      "shot-001",
      "shot-002",
    ],
  };
}

describe("M6 continuous audio-sample timeline", () => {
  it("covers the entire WAV with contiguous shots", () => {
    const result =
      createAudioSampleShotTimeline(
        fixture(),
      );

    expect(result.totalSamples).toBe(72000);
    expect(result.shotCount).toBe(2);

    expect(result.shots[0]).toMatchObject({
      shotId: "shot-001",
      startSample: 0,
      endSampleExclusive: 27072,
      durationSamples: 27072,
      speechStartSample: 984,
      speechEndSampleExclusive: 27072,
    });

    expect(result.shots[1]).toMatchObject({
      shotId: "shot-002",
      startSample: 27072,
      endSampleExclusive: 72000,
      durationSamples: 44928,
      speechStartSample: 27072,
      speechEndSampleExclusive: 66384,
    });

    expect(
      result.shots[0]!.endSampleExclusive,
    ).toBe(result.shots[1]!.startSample);
  });

  it("preserves initial and trailing silence", () => {
    const result =
      createAudioSampleShotTimeline(
        fixture(),
      );

    expect(
      result.shots[0]!.speechStartSample,
    ).toBeGreaterThan(
      result.shots[0]!.startSample,
    );

    expect(
      result.shots[1]!.endSampleExclusive,
    ).toBeGreaterThan(
      result.shots[1]!.speechEndSampleExclusive,
    );
  });

  it("produces a deterministic timeline hash", () => {
    const input = fixture();

    expect(
      createAudioSampleShotTimeline(input),
    ).toEqual(
      createAudioSampleShotTimeline(input),
    );
  });

  it("verifies a saved timeline by reconstruction", () => {
    const input = fixture();

    const saved =
      createAudioSampleShotTimeline(
        input,
      );

    expect(
      verifyAudioSampleShotTimeline(
        saved,
        input,
      ),
    ).toEqual(saved);
  });

  it("rejects a different authoritative M3 shot order", () => {
    const input = fixture();

    input.authoritativeShotIds.reverse();

    expect(() =>
      createAudioSampleShotTimeline(input),
    ).toThrow(
      "Audio timeline M3 shot mismatch",
    );
  });

  it("rejects zero-duration shots", () => {
    const input = fixture();

    // Produces two shot starts at the same
    // audio sample if accepted.
    input.anchors.anchors[1]!.startSample = 0;

    // Recompute the anchor hash to ensure the
    // timeline's semantic validation is exercised,
    // not just its hash validation.
    const {
      anchorPackageHash: _ignored,
      ...payload
    } = input.anchors;

    input.anchors.anchorPackageHash = hash(
      JSON.stringify(payload),
    );

    expect(() =>
      createAudioSampleShotTimeline(input),
    ).toThrow(
      "Audio timeline invalid shot duration",
    );
  });

  it("rejects corrupted anchor hashes", () => {
    const input = fixture();

    input.anchors.anchorPackageHash =
      "0".repeat(64);

    expect(() =>
      createAudioSampleShotTimeline(input),
    ).toThrow(
      "Audio timeline anchor integrity mismatch",
    );
  });

  it("rejects altered persisted timeline content", () => {
    const input = fixture();

    const saved =
      createAudioSampleShotTimeline(
        input,
      );

    const tampered = structuredClone(saved);

    tampered.shots[0]!.durationSamples += 1;

    expect(() =>
      verifyAudioSampleShotTimeline(
        tampered,
        input,
      ),
    ).toThrow(
      "Audio timeline canonical reconstruction mismatch",
    );
  });
});
