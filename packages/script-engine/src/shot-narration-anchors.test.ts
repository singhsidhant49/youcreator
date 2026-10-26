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
  verifyShotNarrationAnchors,
} from "./shot-narration-anchors.js";

const JOB_ID = "job-m6-shot-anchors";

const SCRIPT =
  "Hello world. This is YouCreator.";

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

  return {
    jobId: JOB_ID,

    productionPackageHash:
      hash("m3-production-package"),

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
  };
}

describe("M6 canonical shot narration anchors", () => {
  it("maps each shot to verified word samples", () => {
    const result =
      createShotNarrationAnchors(
        fixture(),
      );

    expect(result.shotCount).toBe(2);
    expect(result.tokenCount).toBe(7);

    expect(result.anchors[0]).toMatchObject({
      shotId: "shot-001",
      startTokenIndex: 0,
      endTokenIndexExclusive: 3,
      startSample: 984,
      endSampleExclusive: 27072,
    });

    expect(result.anchors[1]).toMatchObject({
      shotId: "shot-002",
      startTokenIndex: 3,
      endTokenIndexExclusive: 7,
      startSample: 27072,
      endSampleExclusive: 66384,
    });
  });

  it("produces deterministic anchor hashes", () => {
    const input = fixture();

    expect(
      createShotNarrationAnchors(input),
    ).toEqual(
      createShotNarrationAnchors(input),
    );
  });

  it("verifies persisted anchors by reconstruction", () => {
    const input = fixture();

    const saved =
      createShotNarrationAnchors(input);

    expect(
      verifyShotNarrationAnchors(
        saved,
        input,
      ),
    ).toEqual(saved);
  });

  it("rejects uncovered narration tokens", () => {
    const input = fixture();

    input.shots[1]!.endTokenIndexExclusive = 6;

    expect(() =>
      createShotNarrationAnchors(input),
    ).toThrow(
      "Shot narration leaves unassigned tokens",
    );
  });

  it("rejects gaps between shot token ranges", () => {
    const input = fixture();

    input.shots[1]!.startTokenIndex = 4;

    expect(() =>
      createShotNarrationAnchors(input),
    ).toThrow(
      "Shot narration token range invalid",
    );
  });

  it("rejects overlapping token ranges", () => {
    const input = fixture();

    input.shots[1]!.startTokenIndex = 2;

    expect(() =>
      createShotNarrationAnchors(input),
    ).toThrow(
      "Shot narration token range invalid",
    );
  });

  it("rejects duplicate shot IDs", () => {
    const input = fixture();

    input.shots[1]!.shotId = "shot-001";

    expect(() =>
      createShotNarrationAnchors(input),
    ).toThrow(
      "Shot narration IDs or ordering invalid",
    );
  });

  it("rejects a changed authoritative script", () => {
    const input = fixture();

    input.scriptText =
      "Goodbye world. This is YouCreator.";

    expect(() =>
      createShotNarrationAnchors(input),
    ).toThrow(
      "Shot narration script identity mismatch",
    );
  });
});
