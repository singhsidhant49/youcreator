import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  NarrationAudio,
} from "./narration-audio-contract.js";

import {
  createNarrationWordAlignment,
  verifyNarrationWordAlignment,
} from "./narration-alignment-contract.js";

const audioFixture: NarrationAudio = {
  version: 1,
  jobId: "job-m6-contract",
  format: "wav_pcm_s16le",
  sha256: "a".repeat(64),
  bytes: 144044,
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  sampleFrames: 72000,
  durationSeconds: 3,
  audioHash: "b".repeat(64),
};

const scriptText = "Hello world. This is YouCreator.";

const timestampsFixture = [
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
];

describe("Narration word alignment contract", () => {
  it("creates valid word alignment from matching script and timestamps", () => {
    const alignment = createNarrationWordAlignment({
      scriptText,
      audio: audioFixture,
      timestamps: timestampsFixture,
    });

    expect(alignment.words).toHaveLength(7);
    expect(alignment.audioSha256).toBe(audioFixture.sha256);
    expect(alignment.jobId).toBe(audioFixture.jobId);
    expect(alignment.version).toBe(1);
  });

  it("computes exact sample indices matching sample rate", () => {
    const alignment = createNarrationWordAlignment({
      scriptText,
      audio: audioFixture,
      timestamps: timestampsFixture,
    });

    expect(alignment.words[0]?.startSample).toBe(984);
    expect(alignment.words[0]?.endSampleExclusive).toBe(9384);
    expect(alignment.words[6]?.endSampleExclusive).toBe(66384);
  });

  it("produces a deterministic alignment hash", () => {
    const first = createNarrationWordAlignment({
      scriptText,
      audio: audioFixture,
      timestamps: timestampsFixture,
    });

    const second = createNarrationWordAlignment({
      scriptText,
      audio: audioFixture,
      timestamps: timestampsFixture,
    });

    expect(first.alignmentHash).toBe(second.alignmentHash);
    expect(first.alignmentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects token coverage mismatch when timestamp count differs", () => {
    expect(() =>
      createNarrationWordAlignment({
        scriptText,
        audio: audioFixture,
        timestamps: timestampsFixture.slice(0, 5),
      }),
    ).toThrow("Narration token coverage mismatch");
  });

  it("rejects token mismatch when word content drifts", () => {
    const drifted = structuredClone(timestampsFixture);
    drifted[1]!.word = "planet";

    expect(() =>
      createNarrationWordAlignment({
        scriptText,
        audio: audioFixture,
        timestamps: drifted,
      }),
    ).toThrow("Narration token mismatch");
  });

  it("rejects timestamps exceeding audio duration or sample frames", () => {
    const outOfBounds = structuredClone(timestampsFixture);
    outOfBounds[6]!.end_time = 3.5;

    expect(() =>
      createNarrationWordAlignment({
        scriptText,
        audio: audioFixture,
        timestamps: outOfBounds,
      }),
    ).toThrow("Invalid narration sample bounds");
  });

  it("verifies persisted or serialized alignment package", () => {
    const alignment = createNarrationWordAlignment({
      scriptText,
      audio: audioFixture,
      timestamps: timestampsFixture,
    });

    const verified = verifyNarrationWordAlignment(
      alignment,
      audioFixture,
    );

    expect(verified).toEqual(alignment);

    expect(() =>
      verifyNarrationWordAlignment(
        {
          ...alignment,
          audioSha256: "c".repeat(64),
        },
        audioFixture,
      ),
    ).toThrow();
  });

  it("normalizes cascading multi-token backward overlaps across sentence boundaries", () => {
    // Simulates punctuation pause where subsequent word starts earlier than punctuation ends
    const cascadeTimestamps = [
      { word: "Hello", start_time: 0.041, end_time: 0.391 },
      { word: "world", start_time: 0.391, end_time: 0.966 },
      { word: ".", start_time: 0.966, end_time: 1.200 }, // punctuation ends late at 1.200
      { word: "This", start_time: 1.100, end_time: 1.341 }, // next sentence starts at 1.100 (< 1.200)
      { word: "is", start_time: 1.341, end_time: 1.491 },
      { word: "YouCreator", start_time: 1.491, end_time: 2.541 },
      { word: ".", start_time: 2.541, end_time: 2.766 },
    ];

    const alignment = createNarrationWordAlignment({
      scriptText,
      audio: audioFixture,
      timestamps: cascadeTimestamps,
    });

    const verified = verifyNarrationWordAlignment(alignment, audioFixture);
    expect(verified).toBeDefined();

    // Word 2 ('.') should be clamped to 1.100 (26400 samples)
    expect(alignment.words[2]!.endSampleExclusive).toBe(26400);
    // Word 3 ('This') should start at 1.100 (26400 samples)
    expect(alignment.words[3]!.startSample).toBe(26400);

    // Verify all words strictly satisfy monotonicity (startSample >= previous endSampleExclusive)
    let prevEnd = 0;
    for (const [idx, word] of alignment.words.entries()) {
      expect(word.startSample).toBeGreaterThanOrEqual(prevEnd);
      expect(word.endSampleExclusive).toBeGreaterThanOrEqual(word.startSample);
      prevEnd = word.endSampleExclusive;
    }
  });
});

