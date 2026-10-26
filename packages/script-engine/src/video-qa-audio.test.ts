import {
  describe,
  expect,
  it,
} from "vitest";

import {
  amplitudeToDbfs,
  analyzeVideoQaAudio,
} from "./video-qa-audio-analyzer.js";

const SAMPLE_RATE = 16000;

function tone(
  seconds: number,
  amplitude = 0.25,
): Buffer {
  const count = Math.round(
    seconds * SAMPLE_RATE,
  );

  const pcm = Buffer.alloc(count * 2);

  for (let i = 0; i < count; i++) {
    const value = Math.round(
      amplitude *
      Math.sin(
        2 * Math.PI * 440 *
        i / SAMPLE_RATE,
      ) *
      32767,
    );

    pcm.writeInt16LE(
      value,
      i * 2,
    );
  }

  return pcm;
}

function silence(seconds: number): Buffer {
  return Buffer.alloc(
    Math.round(seconds * SAMPLE_RATE) * 2,
  );
}

describe("M8.3 audio quality analysis", () => {
  it("measures a normal audio signal", () => {
    const report = analyzeVideoQaAudio(
      tone(1),
      SAMPLE_RATE,
    );

    expect(report.peak).toBeGreaterThan(0.2);
    expect(report.rms).toBeGreaterThan(0.1);
    expect(report.clippingFraction).toBe(0);

    expect(report.findings).toEqual([]);
  });

  it("detects excessive continuous silence", () => {
    const report = analyzeVideoQaAudio(
      Buffer.concat([
        tone(0.5),
        silence(1),
        tone(0.5),
      ]),
      SAMPLE_RATE,
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "EXCESSIVE_SILENCE",
      ),
    ).toBe(true);
  });

  it("detects possible internal dropouts", () => {
    const report = analyzeVideoQaAudio(
      Buffer.concat([
        tone(0.5),
        silence(0.5),
        tone(0.5),
      ]),
      SAMPLE_RATE,
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code ===
          "POSSIBLE_AUDIO_DROPOUT",
      ),
    ).toBe(true);
  });

  it("does not flag short natural pauses", () => {
    const report = analyzeVideoQaAudio(
      Buffer.concat([
        tone(0.5),
        silence(0.1),
        tone(0.5),
      ]),
      SAMPLE_RATE,
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code ===
            "POSSIBLE_AUDIO_DROPOUT" ||
          finding.code ===
            "EXCESSIVE_SILENCE",
      ),
    ).toBe(false);
  });

  it("detects a high proportion of clipped samples", () => {
    const pcm = Buffer.alloc(
      SAMPLE_RATE * 2,
    );

    for (let i = 0; i < SAMPLE_RATE; i++) {
      pcm.writeInt16LE(
        i % 2 === 0 ? 32767 : -32768,
        i * 2,
      );
    }

    const report = analyzeVideoQaAudio(
      pcm,
      SAMPLE_RATE,
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "POSSIBLE_CLIPPING",
      ),
    ).toBe(true);
  });

  it("detects very low RMS audio", () => {
    const report = analyzeVideoQaAudio(
      tone(1, 0.001),
      SAMPLE_RATE,
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "LOW_AUDIO_LEVEL",
      ),
    ).toBe(true);
  });

  it("detects excessive overall RMS", () => {
    const report = analyzeVideoQaAudio(
      tone(1, 0.8),
      SAMPLE_RATE,
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === "HIGH_AUDIO_LEVEL",
      ),
    ).toBe(true);
  });

  it("calculates amplitude dBFS correctly", () => {
    expect(amplitudeToDbfs(1)).toBe(0);
    expect(amplitudeToDbfs(0.5)).toBeCloseTo(
      -6.0206,
      3,
    );
    expect(amplitudeToDbfs(0)).toBe(-120);
  });

  it("produces deterministic report hashes", () => {
    const pcm = tone(1);

    const a = analyzeVideoQaAudio(
      pcm,
      SAMPLE_RATE,
    );

    const b = analyzeVideoQaAudio(
      pcm,
      SAMPLE_RATE,
    );

    expect(a).toEqual(b);

    expect(a.reportHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects malformed PCM", () => {
    expect(() =>
      analyzeVideoQaAudio(
        Buffer.from([1]),
        SAMPLE_RATE,
      ),
    ).toThrow("M8 invalid decoded audio");
  });

  it("correlates silence at sentence boundary as EXPECTED_SPEECH_PAUSE", () => {
    const pcm = Buffer.concat([
      tone(0.5),
      silence(0.4),
      tone(0.5),
    ]);
    const words = [
      { word: "Hello.", startMs: 0, endMs: 500 },
      { word: "World.", startMs: 900, endMs: 1400 },
    ];
    const report = analyzeVideoQaAudio(pcm, SAMPLE_RATE, { words });
    expect(report.findings.some((f) => f.code === "EXPECTED_SPEECH_PAUSE")).toBe(true);
    expect(report.findings.some((f) => f.code === "POSSIBLE_AUDIO_DROPOUT")).toBe(false);
    expect(report.findings.some((f) => f.code === "EXCESSIVE_SILENCE")).toBe(false);
    const pauseFinding = report.findings.find((f) => f.code === "EXPECTED_SPEECH_PAUSE");
    expect(pauseFinding?.severity).toBe("info");
  });

  it("detects mid-speech silence overlapping active speech interval as POSSIBLE_AUDIO_DROPOUT", () => {
    const pcm = Buffer.concat([
      tone(0.2),
      silence(0.4),
      tone(0.4),
    ]);
    const words = [
      { word: "ContinuousSpeechWithoutBreak", startMs: 0, endMs: 1000 },
    ];
    const report = analyzeVideoQaAudio(pcm, SAMPLE_RATE, { words });
    expect(report.findings.some((f) => f.code === "POSSIBLE_AUDIO_DROPOUT")).toBe(true);
    const dropout = report.findings.find((f) => f.code === "POSSIBLE_AUDIO_DROPOUT");
    expect(dropout?.severity).toBe("warning");
  });

  it("detects excessive sentence pause exceeding maxSentencePauseMs as EXCESSIVE_SILENCE", () => {
    const pcm = Buffer.concat([
      tone(0.5),
      silence(1.8),
      tone(0.5),
    ]);
    const words = [
      { word: "Hello.", startMs: 0, endMs: 500 },
      { word: "World.", startMs: 2300, endMs: 2800 },
    ];
    const report = analyzeVideoQaAudio(pcm, SAMPLE_RATE, { words });
    expect(report.findings.some((f) => f.code === "EXCESSIVE_SILENCE")).toBe(true);
  });
});
