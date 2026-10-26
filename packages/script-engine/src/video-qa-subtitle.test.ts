import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  createRemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import {
  analyzeVideoQaSubtitles,
  contrastRatio,
  estimateCaptionLines,
  verifyVideoQaSubtitleReport,
} from "./video-qa-subtitle-analyzer.js";

const H = "a".repeat(64);

function fixture(): RemotionComposition {
  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId: "m8-subtitle-job",
    productionPackageHash: H,
    m6VisualHash: H,
    visualPackageHash: H,
    framePlanHash: H,
    scriptHash: H,
    alignmentHash: H,
    audioSha256: H,
    compositionHash: H,
    fps: 30,
    width: 1920,
    height: 1080,
    totalFrames: 90,
    shotCount: 1,

    audio: {
      format: "wav_pcm_s16le",
      path: "/tmp/narration.wav",
      sha256: H,
      sampleRate: 24000,
      sampleFrames: 72000,
      channels: 1,
      bitsPerSample: 16,
    },

    shots: [{
      version: 1,
      shotId: "shot-1",
      shotIndex: 0,
      bindingHash: H,
      assetSha256: H,
      assetId: "asset-1",
      assetPath: "/tmp/image.png",
      sourceWidth: 1920,
      sourceHeight: 1080,
      startFrame: 0,
      endFrameExclusive: 90,
      durationFrames: 90,
      fit: "contain",
      motion: "static",
      startCrop: null,
      endCrop: null,
    }],

    words: [
      {
        tokenIndex: 0,
        word: "Welcome",
        index: 0,
        text: "Welcome",
        startSample: 0,
        endSampleExclusive: 12000,
        startSeconds: 0,
        endSeconds: 0.5,
      },
      {
        tokenIndex: 1,
        word: "back.",
        index: 1,
        text: "back.",
        startSample: 12000,
        endSampleExclusive: 24000,
        startSeconds: 0.5,
        endSeconds: 1,
      },
      {
        tokenIndex: 2,
        word: "Today",
        index: 2,
        text: "Today",
        startSample: 36000,
        endSampleExclusive: 48000,
        startSeconds: 1.5,
        endSeconds: 2,
      },
      {
        tokenIndex: 3,
        word: "we",
        index: 3,
        text: "we",
        startSample: 48000,
        endSampleExclusive: 54000,
        startSeconds: 2,
        endSeconds: 2.25,
      },
      {
        tokenIndex: 4,
        word: "begin.",
        index: 4,
        text: "begin.",
        startSample: 54000,
        endSampleExclusive: 66000,
        startSeconds: 2.25,
        endSeconds: 2.75,
      },
    ],
  };
}

function analyze(
  manifest: RemotionComposition = fixture(),
  policy: Parameters<
    typeof analyzeVideoQaSubtitles
  >[2] = {},
) {
  const captions =
    createRemotionCaptionPlan(manifest);

  return analyzeVideoQaSubtitles(
    manifest,
    captions,
    policy,
  );
}

describe("M8.4 subtitle QA", () => {
  it("creates a deterministic report", () => {
    const manifest = fixture();
    const captions =
      createRemotionCaptionPlan(manifest);

    const result = analyzeVideoQaSubtitles(
      manifest,
      captions,
    );

    expect(result.jobId).toBe(manifest.jobId);
    expect(result.cueCount).toBe(2);
    expect(result.reportHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    expect(
      verifyVideoQaSubtitleReport(
        result,
        manifest,
        captions,
      ),
    ).toEqual(result);
  });

  it("accepts ordinary readable cues", () => {
    const report = analyze();

    expect(report.findings).toEqual([]);
  });

  it("detects captions displayed too quickly", () => {
    const report = analyze(fixture(), {
      maxCharactersPerSecond: 4,
    });

    expect(
      report.findings.some(
        (f) => f.code === "CAPTION_TOO_FAST",
      ),
    ).toBe(true);
  });

  it("detects captions that are too short", () => {
    const report = analyze(fixture(), {
      minCueDurationSeconds: 1.2,
    });

    expect(
      report.findings.some(
        (f) => f.code === "CAPTION_TOO_SHORT",
      ),
    ).toBe(true);
  });

  it("detects overlong caption exposure", () => {
    const report = analyze(fixture(), {
      maxCueDurationSeconds: 0.8,
    });

    expect(
      report.findings.some(
        (f) => f.code === "CAPTION_TOO_LONG",
      ),
    ).toBe(true);
  });

  it("detects estimated multi-line overflow", () => {
    const report = analyze(fixture(), {
      fontSizePx: 250,
      maxLines: 1,
    });

    expect(
      report.findings.some(
        (f) => f.code === "SUBTITLE_OVERFLOW",
      ),
    ).toBe(true);
  });

  it("detects insufficient vertical safe space", () => {
    const report = analyze(fixture(), {
      fontSizePx: 850,
      maxLines: 10,
    });

    expect(
      report.findings.some(
        (f) => f.code === "SUBTITLE_SAFE_AREA",
      ),
    ).toBe(true);
  });

  it("calculates contrast correctly", () => {
    expect(
      contrastRatio(
        [255, 255, 255],
        [0, 0, 0],
      ),
    ).toBeCloseTo(21);

    expect(
      contrastRatio(
        [0, 0, 0],
        [0, 0, 0],
      ),
    ).toBe(1);
  });

  it("estimates word wrapping deterministically", () => {
    expect(
      estimateCaptionLines(
        ["Hello", "world"],
        500,
        48,
        13,
      ),
    ).toBe(1);

    expect(
      estimateCaptionLines(
        ["Hello", "world"],
        160,
        48,
        13,
      ),
    ).toBe(2);
  });

  it("rejects invalid policy settings", () => {
    expect(() =>
      analyze(fixture(), {
        safeBottomFraction: -0.2,
      }),
    ).toThrow(
      "M8 invalid subtitle QA policy",
    );
  });

  it("rejects tampered QA reports", () => {
    const manifest = fixture();
    const captions =
      createRemotionCaptionPlan(manifest);

    const report = analyzeVideoQaSubtitles(
      manifest,
      captions,
    );

    const tampered = structuredClone(report);
    tampered.cueCount = 99;

    expect(() =>
      verifyVideoQaSubtitleReport(
        tampered,
        manifest,
        captions,
      ),
    ).toThrow(
      "M8 subtitle QA canonical reconstruction mismatch",
    );
  });

  it("does not flag punctuation-only cues as CAPTION_TOO_SHORT when allowPunctuationOnlyCues is true", () => {
    const f = fixture();
    f.words = [
      {
        tokenIndex: 0,
        word: "Why",
        index: 0,
        text: "Why",
        startSample: 0,
        endSampleExclusive: 12000,
        startSeconds: 0,
        endSeconds: 0.5,
      },
      {
        tokenIndex: 1,
        word: "?",
        index: 1,
        text: "?",
        startSample: 12000,
        endSampleExclusive: 15600,
        startSeconds: 0.5,
        endSeconds: 0.65,
      },
    ];
    const report = analyze(f, {
      minCueDurationSeconds: 0.5,
      allowPunctuationOnlyCues: true,
      minPunctuationCueDurationSeconds: 0.05,
    });
    expect(report.findings.some((finding) => finding.code === "CAPTION_TOO_SHORT")).toBe(false);
  });

  it("still flags short word cues as CAPTION_TOO_SHORT even with allowPunctuationOnlyCues", () => {
    const f = fixture();
    f.words = [
      {
        tokenIndex: 0,
        word: "Hi",
        index: 0,
        text: "Hi",
        startSample: 0,
        endSampleExclusive: 3600,
        startSeconds: 0,
        endSeconds: 0.15,
      },
    ];
    const report = analyze(f, {
      minCueDurationSeconds: 0.5,
      allowPunctuationOnlyCues: true,
    });
    expect(report.findings.some((finding) => finding.code === "CAPTION_TOO_SHORT")).toBe(true);
  });
});
