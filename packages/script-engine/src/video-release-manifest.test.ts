import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createVideoReleaseManifest,
  verifyVideoReleaseManifest,
  type VerifiedReleaseEvidence,
} from "./video-release-manifest.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

function fixture(): VerifiedReleaseEvidence {
  return {
    jobId: "m9-release-test",
    compositionHash: A,
    captionPlanHash: A,
    videoSha256: A,
    videoBytes: 55000,
    qaReportHash: A,
    qaRecordHash: A,
    qaDecision: "PASS",
    codec: "h264",
    audioCodec: "aac",
    fps: 30,
    width: 1920,
    height: 1080,
    totalFrames: 300,
  };
}

describe("M9.1 publication release manifest", () => {
  it("authorizes a verified PASS video", () => {
    const result =
      createVideoReleaseManifest(
        fixture(),
      );

    expect(result.decision).toBe("PASS");
    expect(result.videoSha256).toBe(A);
    expect(result.releaseHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("blocks REVIEW videos", () => {
    expect(() =>
      createVideoReleaseManifest({
        ...fixture(),
        qaDecision: "REVIEW",
      }),
    ).toThrow(
      "M9 publication blocked: REVIEW",
    );
  });

  it("blocks FAIL videos", () => {
    expect(() =>
      createVideoReleaseManifest({
        ...fixture(),
        qaDecision: "FAIL",
      }),
    ).toThrow(
      "M9 publication blocked: FAIL",
    );
  });

  it("reconstructs identical manifests", () => {
    const evidence = fixture();

    const original =
      createVideoReleaseManifest(evidence);

    expect(
      verifyVideoReleaseManifest(
        original,
        evidence,
      ),
    ).toEqual(original);
  });

  it("rejects altered release decisions", () => {
    const evidence = fixture();
    const original =
      createVideoReleaseManifest(evidence);

    const changed = {
      ...original,
      decision: "FAIL",
    };

    expect(() =>
      verifyVideoReleaseManifest(
        changed,
        evidence,
      ),
    ).toThrow();
  });

  it("changes identity when video bytes change", () => {
    const original =
      createVideoReleaseManifest(
        fixture(),
      );

    const updated =
      createVideoReleaseManifest({
        ...fixture(),
        videoSha256: B,
      });

    expect(updated.releaseHash).not.toBe(
      original.releaseHash,
    );
  });

  it("changes identity when QA report changes", () => {
    const original =
      createVideoReleaseManifest(
        fixture(),
      );

    const updated =
      createVideoReleaseManifest({
        ...fixture(),
        qaReportHash: B,
      });

    expect(updated.releaseHash).not.toBe(
      original.releaseHash,
    );
  });

  it("changes identity when captions change", () => {
    const original =
      createVideoReleaseManifest(
        fixture(),
      );

    const updated =
      createVideoReleaseManifest({
        ...fixture(),
        captionPlanHash: B,
      });

    expect(updated.releaseHash).not.toBe(
      original.releaseHash,
    );
  });

  it("rejects invalid artifact hashes", () => {
    expect(() =>
      createVideoReleaseManifest({
        ...fixture(),
        videoSha256: "invalid",
      }),
    ).toThrow();
  });

  it("rejects invalid frame counts", () => {
    expect(() =>
      createVideoReleaseManifest({
        ...fixture(),
        totalFrames: 0,
      }),
    ).toThrow();
  });
});
