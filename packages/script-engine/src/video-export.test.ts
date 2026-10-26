import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createVideoExportManifest,
  verifyVideoExportManifest,
  exportSha256,
} from "./video-export-contract.js";

import {
  createExternalSubtitles,
  frameToSubtitleTimestamp,
} from "./video-export-subtitles.js";

import type {
  RemotionCaptionPlan,
} from "./remotion-caption-plan.js";

const H = "a".repeat(64);

function manifestInput() {
  return {
    version: 1 as const,
    jobId: "video-export-test",
    releaseHash: H,
    compositionHash: H,
    captionPlanHash: H,
    videoSha256: H,
    qaReportHash: H,
    metadataHash: H,
    fps: 30,
    totalFrames: 90,
    width: 1920,
    height: 1080,
    files: [
      "video.mp4",
      "subtitles.srt",
      "subtitles.vtt",
      "metadata.json",
      "qa-report.json",
    ].map((filename) => ({
      filename,
      sha256: H,
      bytes: 100,
    })),
  };
}

function captionFixture(): RemotionCaptionPlan {
  return {
    version: 1,
    compositionHash: H,
    fps: 30,
    totalFrames: 90,
    captionPlanHash: H,
    cues: [
      {
        cueIndex: 0,
        startFrame: 0,
        endFrameExclusive: 30,
        words: [
          {
            index: 0,
            text: "Hello",
            startFrame: 0,
            endFrameExclusive: 15,
          },
          {
            index: 1,
            text: "world.",
            startFrame: 15,
            endFrameExclusive: 30,
          },
        ],
      },
      {
        cueIndex: 1,
        startFrame: 45,
        endFrameExclusive: 75,
        words: [
          {
            index: 2,
            text: "Welcome",
            startFrame: 45,
            endFrameExclusive: 60,
          },
          {
            index: 3,
            text: "back.",
            startFrame: 60,
            endFrameExclusive: 75,
          },
        ],
      },
    ],
  };
}

describe("M9.3 local export contracts", () => {
  it("creates a deterministic manifest", () => {
    const manifest =
      createVideoExportManifest(
        manifestInput() as Parameters<
          typeof createVideoExportManifest
        >[0],
      );

    expect(manifest.exportHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    expect(
      verifyVideoExportManifest(manifest),
    ).toEqual(manifest);
  });

  it("rejects modified manifest identities", () => {
    const manifest =
      createVideoExportManifest(
        manifestInput() as Parameters<
          typeof createVideoExportManifest
        >[0],
      );

    expect(() =>
      verifyVideoExportManifest({
        ...manifest,
        videoSha256: "b".repeat(64),
      }),
    ).toThrow(
      "M9 export manifest integrity mismatch",
    );
  });

  it("rejects duplicate filenames", () => {
    const input =
      manifestInput() as Parameters<
        typeof createVideoExportManifest
      >[0];

    input.files.push(input.files[0]!);

    expect(() =>
      createVideoExportManifest(input),
    ).toThrow(
      "M9 export file inventory invalid",
    );
  });

  it("rejects missing mandatory export files", () => {
    const input =
      manifestInput() as Parameters<
        typeof createVideoExportManifest
      >[0];

    input.files = input.files.filter(
      (file) =>
        file.filename !== "video.mp4",
    );

    expect(() =>
      createVideoExportManifest(input),
    ).toThrow(
      "M9 export file inventory invalid",
    );
  });

  it("calculates SHA-256 from file bytes", () => {
    expect(
      exportSha256(Buffer.from("abc")),
    ).toBe(
      "ba7816bf8f01cfea414140de5dae2223" +
      "b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("uses frame-accurate subtitle timestamps", () => {
    expect(
      frameToSubtitleTimestamp(
        45, 30, "srt",
      ),
    ).toBe("00:00:01,500");

    expect(
      frameToSubtitleTimestamp(
        75, 30, "vtt",
      ),
    ).toBe("00:00:02.500");
  });

  it("generates valid SRT and VTT cues", () => {
    const result =
      createExternalSubtitles(
        captionFixture(),
      );

    expect(result.srt).toContain(
      "1\n00:00:00,000 --> 00:00:01,000",
    );

    expect(result.srt).toContain(
      "Hello world.",
    );

    expect(result.vtt).toContain(
      "WEBVTT",
    );

    expect(result.vtt).toContain(
      "00:00:01.500 --> 00:00:02.500",
    );
  });

  it("preserves silent gaps between cues", () => {
    const result =
      createExternalSubtitles(
        captionFixture(),
      );

    expect(result.srt).toContain(
      "00:00:01,500 --> 00:00:02,500",
    );
  });

  it("rejects overlapping subtitle cues", () => {
    const plan = captionFixture();

    plan.cues[1]!.startFrame = 20;

    expect(() =>
      createExternalSubtitles(plan),
    ).toThrow(
      "M9 invalid or overlapping subtitle cues",
    );
  });

  it("rejects invalid timestamp input", () => {
    expect(() =>
      frameToSubtitleTimestamp(
        -1, 30, "srt",
      ),
    ).toThrow(
      "M9 invalid subtitle frame timing",
    );
  });
});
