import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  CreateUnifiedVideoQaInput,
} from "./video-qa-release-gate.js";

import {
  createUnifiedVideoQaReport,
  verifyUnifiedVideoQaReport,
} from "./video-qa-release-gate.js";

const H = "a".repeat(64);
const JOB_ID = "m8-release-test";

type Input = CreateUnifiedVideoQaInput;

function fixture(): Input {
  return {
    composition: {
      jobId: JOB_ID,
      compositionHash: H,
    } as Input["composition"],

    videoSha256: H,

    frames: {
      inspectedFrames: 10,
      findings: [],
    },

    audio: {
      findings: [],
    } as unknown as Input["audio"],

    subtitles: {
      jobId: JOB_ID,
      compositionHash: H,
      findings: [],
    } as unknown as Input["subtitles"],

    variety: {
      jobId: JOB_ID,
      compositionHash: H,
      findings: [],
    } as unknown as Input["variety"],
  };
}

describe("M8.6 unified video QA gate", () => {
  it("passes when all QA domains are clean", () => {
    const report =
      createUnifiedVideoQaReport(fixture());

    expect(report.decision).toBe("PASS");
    expect(report.overallScore).toBe(100);
    expect(report.blockingCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  it("requests review for visual variety warnings", () => {
    const input = fixture();

    input.variety.findings.push({
      code: "LOW_VISUAL_VARIETY",
      severity: "warning",
      shotIds: ["shot-1", "shot-2"],
      detail: "Repetitive visual sequence",
    });

    const report =
      createUnifiedVideoQaReport(input);

    expect(report.decision).toBe("REVIEW");
    expect(report.blockingCount).toBe(0);
    expect(report.overallScore).toBe(96);
  });

  it("fails when a black frame is detected", () => {
    const input = fixture();

    input.frames.findings.push({
      code: "BLACK_FRAME",
      severity: "error",
      shotId: "shot-1",
      frame: 12,
      detail: "Nearly black encoded frame",
    });

    const report =
      createUnifiedVideoQaReport(input);

    expect(report.decision).toBe("FAIL");
    expect(report.blockingCount).toBe(1);
  });

  it("cannot offset a blocking error with high scores", () => {
    const input = fixture();

    input.frames.findings.push({
      code: "BLACK_FRAME",
      severity: "error",
      shotId: "shot-1",
      frame: 4,
      detail: "Black frame",
    });

    const report =
      createUnifiedVideoQaReport(input);

    expect(report.overallScore).toBe(80);
    expect(report.decision).toBe("FAIL");

    expect(
      report.domainScores.filter(
        (score) => score.score === 100,
      ),
    ).toHaveLength(3);
  });

  it("keeps exact asset reuse as a review warning", () => {
    const input = fixture();

    input.variety.findings.push({
      code: "EXACT_ASSET_REUSE",
      severity: "warning",
      shotIds: ["shot-1", "shot-2", "shot-3"],
      detail: "Same asset reused three times",
    });

    const report =
      createUnifiedVideoQaReport(input);

    expect(report.decision).toBe("REVIEW");
    expect(report.blockingCount).toBe(0);
  });

  it("fails on subtitle safe-area violations", () => {
    const input = fixture();

    input.subtitles.findings.push({
      code: "SUBTITLE_SAFE_AREA",
      severity: "error",
      cueIndex: 0,
      startFrame: 10,
      endFrameExclusive: 40,
      detail: "Caption clipped by screen boundary",
    });

    expect(
      createUnifiedVideoQaReport(input).decision,
    ).toBe("FAIL");
  });

  it("supports additional blocking warning codes", () => {
    const input = fixture();

    input.variety.findings.push({
      code: "LOW_VISUAL_VARIETY",
      severity: "warning",
      shotIds: ["shot-1"],
      detail: "Low visual variety",
    });

    const report = createUnifiedVideoQaReport(
      input,
      {
        additionalBlockingCodes: [
          "variety:LOW_VISUAL_VARIETY",
        ],
      },
    );

    expect(report.decision).toBe("FAIL");
    expect(report.blockingCount).toBe(1);
  });

  it("rejects inconsistent upstream composition", () => {
    const input = fixture();

    input.subtitles.compositionHash =
      "b".repeat(64);

    expect(() =>
      createUnifiedVideoQaReport(input),
    ).toThrow(
      "M8 unified QA subtitle composition mismatch",
    );
  });

  it("rejects incorrect job ownership", () => {
    const input = fixture();

    input.variety.jobId = "another-job";

    expect(() =>
      createUnifiedVideoQaReport(input),
    ).toThrow(
      "M8 unified QA job identity mismatch",
    );
  });

  it("reconstructs deterministic reports", () => {
    const input = fixture();

    const report =
      createUnifiedVideoQaReport(input);

    expect(
      verifyUnifiedVideoQaReport(
        report,
        input,
      ),
    ).toEqual(report);

    expect(
      createUnifiedVideoQaReport(input),
    ).toEqual(report);
  });

  it("rejects tampered release decisions", () => {
    const input = fixture();

    const report =
      createUnifiedVideoQaReport(input);

    const tampered = structuredClone(report);
    tampered.decision = "FAIL";

    expect(() =>
      verifyUnifiedVideoQaReport(
        tampered,
        input,
      ),
    ).toThrow(
      "M8 unified QA canonical reconstruction mismatch",
    );
  });

  it("rejects invalid scoring policies", () => {
    expect(() =>
      createUnifiedVideoQaReport(
        fixture(),
        { warningPenalty: -1 },
      ),
    ).toThrow(
      "M8 invalid release gate policy",
    );
  });

  it("treats info severity findings as non-penalizing and passes release gate", () => {
    const input = fixture();
    input.audio.findings = [
      {
        code: "EXPECTED_SPEECH_PAUSE",
        severity: "info",
        startSeconds: 1.0,
        endSeconds: 1.5,
        detail: "500 ms intentional pause at sentence boundary",
      },
    ];

    const report = createUnifiedVideoQaReport(input);
    expect(report.decision).toBe("PASS");
    expect(report.overallScore).toBe(100);
    expect(report.warningCount).toBe(0);
    expect(report.blockingCount).toBe(0);
    const audioDomain = report.domainScores.find((d) => d.domain === "audio");
    expect(audioDomain?.score).toBe(100);
    expect(audioDomain?.warnings).toBe(0);
    expect(audioDomain?.errors).toBe(0);
  });

  it("blocks release on POSSIBLE_AUDIO_DROPOUT warning", () => {
    const input = fixture();
    input.audio.findings = [
      {
        code: "POSSIBLE_AUDIO_DROPOUT",
        severity: "warning",
        startSeconds: 0.5,
        endSeconds: 0.9,
        detail: "400 ms unexpected quiet interval between words",
      },
    ];

    const report = createUnifiedVideoQaReport(input);
    expect(report.decision).toBe("REVIEW");
    expect(report.warningCount).toBe(1);
    expect(report.blockingCount).toBe(0);
    expect(report.overallScore).toBeLessThan(100);
  });

  it("embeds policyId and modifies reportHash deterministically", () => {
    const input = fixture();
    const defaultReport = createUnifiedVideoQaReport(input);
    const calibratedReport = createUnifiedVideoQaReport(input, {
      policyId: "calibrated-v1",
    });

    expect(calibratedReport.policyId).toBe("calibrated-v1");
    expect(defaultReport.policyId).toBeUndefined();
    expect(calibratedReport.reportHash).not.toBe(defaultReport.reportHash);
    expect(calibratedReport.reportHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
