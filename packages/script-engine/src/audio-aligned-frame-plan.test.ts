import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

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
} from "./audio-sample-shot-timeline.js";

import {
  ceilSampleToFrame,
  createAudioAlignedFramePlan,
  roundSampleToFrame,
  verifyAudioAlignedFramePlan,
} from "./audio-aligned-frame-plan.js";

const JOB_ID = "job-m6-frame-plan";
const SCRIPT = "Hello world. This is YouCreator.";

function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      typeof value === "string"
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
}

function wavFixture(
  frames = 72000,
): Buffer {
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

  const alignment =
    createNarrationWordAlignment({
      scriptText: SCRIPT,
      audio,
      timestamps: [
        { word: "Hello", start_time: 0.041, end_time: 0.391 },
        { word: "world", start_time: 0.391, end_time: 0.966 },
        { word: ".", start_time: 0.966, end_time: 1.128 },
        { word: "This", start_time: 1.128, end_time: 1.341 },
        { word: "is", start_time: 1.341, end_time: 1.491 },
        { word: "YouCreator", start_time: 1.491, end_time: 2.541 },
        { word: ".", start_time: 2.541, end_time: 2.766 },
      ],
    });

  const anchors = createShotNarrationAnchors({
    jobId: JOB_ID,
    productionPackageHash:
      hash("verified-m3-package"),
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
    timeline: createAudioSampleShotTimeline({
      anchors,
      authoritativeShotIds: [
        "shot-001",
        "shot-002",
      ],
    }),
    fps: 30,
    authoritativeShotIds: [
      "shot-001",
      "shot-002",
    ],
  };
}

describe("M6 audio-aligned frame plan", () => {
  it("converts the real sample timeline into contiguous frames", () => {
    const result = createAudioAlignedFramePlan(
      fixture(),
    );

    expect(result.totalFrames).toBe(90);
    expect(result.shotCount).toBe(2);

    expect(result.shots[0]).toMatchObject({
      shotId: "shot-001",
      startFrame: 0,
      endFrameExclusive: 34,
      durationFrames: 34,
    });

    expect(result.shots[1]).toMatchObject({
      shotId: "shot-002",
      startFrame: 34,
      endFrameExclusive: 90,
      durationFrames: 56,
    });
  });

  it("uses ceiling for the final audio boundary", () => {
    expect(
      ceilSampleToFrame(24001, 24000, 30),
    ).toBe(31);

    expect(
      roundSampleToFrame(24001, 24000, 30),
    ).toBe(30);
  });

  it("uses exact integer arithmetic at half-frame boundaries", () => {
    expect(
      roundSampleToFrame(400, 24000, 30),
    ).toBe(1);

    expect(
      roundSampleToFrame(399, 24000, 30),
    ).toBe(0);

    expect(
      roundSampleToFrame(1200, 24000, 30),
    ).toBe(2);
  });

  it("is deterministic across repeated reconstruction", () => {
    const input = fixture();

    expect(
      createAudioAlignedFramePlan(input),
    ).toEqual(
      createAudioAlignedFramePlan(input),
    );
  });

  it("verifies saved frame plans against authoritative inputs", () => {
    const input = fixture();

    const saved =
      createAudioAlignedFramePlan(input);

    expect(
      verifyAudioAlignedFramePlan(
        saved,
        input,
      ),
    ).toEqual(saved);
  });

  it("rejects mismatched authoritative M3 shot order", () => {
    const input = fixture();

    input.authoritativeShotIds.reverse();

    expect(() =>
      createAudioAlignedFramePlan(input),
    ).toThrow(
      "Audio frame plan authoritative M3 mismatch",
    );
  });

  it("rejects zero-frame shots after quantization", () => {
    const input = fixture();

    // Make Shot 1 shorter than half a frame.
    // Recompute the timeline hash to exercise
    // semantic checks rather than only hash checks.
    input.timeline.shots[0]!.endSampleExclusive = 1;
    input.timeline.shots[0]!.durationSamples = 1;

    input.timeline.shots[1]!.startSample = 1;
    input.timeline.shots[1]!.durationSamples =
      input.timeline.totalSamples - 1;

    const {
      timelineHash: _old,
      ...payload
    } = input.timeline;

    input.timeline.timelineHash = hash(payload);

    expect(() =>
      createAudioAlignedFramePlan(input),
    ).toThrow(
      "Audio frame plan zero-duration or invalid shot",
    );
  });

  it("rejects persisted frame-boundary tampering", () => {
    const input = fixture();

    const saved =
      createAudioAlignedFramePlan(input);

    const tampered = structuredClone(saved);

    tampered.shots[0]!.endFrameExclusive += 1;

    expect(() =>
      verifyAudioAlignedFramePlan(
        tampered,
        input,
      ),
    ).toThrow(
      "Audio frame plan canonical reconstruction mismatch",
    );
  });

  it("rejects corrupted upstream sample timeline identity", () => {
    const input = fixture();

    input.timeline.timelineHash =
      "0".repeat(64);

    expect(() =>
      createAudioAlignedFramePlan(input),
    ).toThrow(
      "Audio frame plan timeline integrity mismatch",
    );
  });
});
