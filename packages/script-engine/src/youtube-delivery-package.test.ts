import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createVideoReleaseManifest,
  type VerifiedReleaseEvidence,
} from "./video-release-manifest.js";

import {
  normalizeYoutubeMetadata,
} from "./youtube-delivery-metadata.js";

import {
  createYoutubeDeliveryPackage,
  toYoutubeInsertPayload,
  verifyYoutubeDeliveryPackage,
  type CreateYoutubeDeliveryPackageInput,
} from "./youtube-delivery-package.js";

const H = "a".repeat(64);
const B = "b".repeat(64);

function evidence(): VerifiedReleaseEvidence {
  return {
    jobId: "m9-youtube-package",
    compositionHash: H,
    captionPlanHash: H,
    videoSha256: H,
    videoBytes: 123456,
    qaReportHash: H,
    qaRecordHash: H,
    qaDecision: "PASS",
    codec: "h264",
    audioCodec: "aac",
    fps: 30,
    width: 1920,
    height: 1080,
    totalFrames: 1800,
  };
}

function fixture(): CreateYoutubeDeliveryPackageInput {
  const releaseEvidence = evidence();

  return {
    releaseEvidence,
    release:
      createVideoReleaseManifest(
        releaseEvidence,
      ),
    metadata: {
      title: "How AI Is Changing Software",
      description:
        "An introduction to AI-driven development.",
      tags: [
        "artificial intelligence",
        "software",
      ],
      categoryId: "28",
      defaultLanguage: "en",
      chapters: [
        { startSeconds: 0, title: "Introduction" },
        { startSeconds: 20, title: "How It Works" },
        { startSeconds: 40, title: "What's Next" },
      ],
    },
    intent: {
      channelId:
        "UC" + "a".repeat(22),
      privacyStatus: "private",
      madeForKids: false,
      containsSyntheticMedia: false,
    },
  };
}

describe("M9.2 YouTube delivery package", () => {
  it("creates an immutable delivery identity", () => {
    const value =
      createYoutubeDeliveryPackage(
        fixture(),
      );

    expect(value.provider).toBe("youtube");
    expect(value.packageHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(value.videoSha256).toBe(H);
  });

  it("reconstructs the package deterministically", () => {
    const input = fixture();
    const value =
      createYoutubeDeliveryPackage(input);

    expect(
      verifyYoutubeDeliveryPackage(
        value,
        input,
      ),
    ).toEqual(value);
  });

  it("rejects modified package content", () => {
    const input = fixture();
    const value =
      createYoutubeDeliveryPackage(input);

    expect(() =>
      verifyYoutubeDeliveryPackage(
        {
          ...value,
          videoSha256: B,
        },
        input,
      ),
    ).toThrow(
      "M9 YouTube delivery package reconstruction mismatch",
    );
  });

  it("generates chapter timestamps", () => {
    const value =
      createYoutubeDeliveryPackage(
        fixture(),
      );

    expect(
      value.metadata.description,
    ).toContain("00:00 Introduction");

    expect(
      value.metadata.description,
    ).toContain("00:20 How It Works");
  });

  it("rejects titles longer than 100 characters", () => {
    const input = fixture();

    input.metadata.title =
      "A".repeat(101);

    expect(() =>
      createYoutubeDeliveryPackage(input),
    ).toThrow(
      "M9 YouTube title exceeds limit",
    );
  });

  it("rejects oversized descriptions", () => {
    const input = fixture();

    input.metadata.description =
      "A".repeat(5001);

    expect(() =>
      createYoutubeDeliveryPackage(input),
    ).toThrow(
      "M9 YouTube description exceeds API limit",
    );
  });

  it("rejects duplicate tags", () => {
    const input = fixture();

    input.metadata.tags = [
      "Science",
      "science",
    ];

    expect(() =>
      createYoutubeDeliveryPackage(input),
    ).toThrow(
      "M9 duplicate YouTube tags",
    );
  });

  it("rejects invalid chapter intervals", () => {
    const input = fixture();

    input.metadata.chapters = [
      { startSeconds: 0, title: "Start" },
      { startSeconds: 5, title: "Too Early" },
      { startSeconds: 40, title: "End" },
    ];

    expect(() =>
      createYoutubeDeliveryPackage(input),
    ).toThrow(
      "M9 chapter duration must be at least ten seconds",
    );
  });

  it("allows videos without chapters", () => {
    const input = fixture();

    input.metadata.chapters = [];

    expect(
      createYoutubeDeliveryPackage(input)
        .metadata.chapters,
    ).toEqual([]);
  });

  it("blocks non-PASS release evidence", () => {
    const input = fixture();

    input.releaseEvidence.qaDecision =
      "REVIEW";

    expect(() =>
      createYoutubeDeliveryPackage(input),
    ).toThrow(
      "M9 publication blocked: REVIEW",
    );
  });

  it("produces a provider-ready upload body", () => {
    const value =
      createYoutubeDeliveryPackage(
        fixture(),
      );

    const body =
      toYoutubeInsertPayload(value);

    expect(body.snippet.title).toBe(
      "How AI Is Changing Software",
    );

    expect(body.status.privacyStatus).toBe(
      "private",
    );

    expect(
      body.status.selfDeclaredMadeForKids,
    ).toBe(false);
  });

  it("changes package identity when metadata changes", () => {
    const first = fixture();
    const second = fixture();

    second.metadata.title =
      "A New Title";

    const a =
      createYoutubeDeliveryPackage(first);

    const b =
      createYoutubeDeliveryPackage(second);

    expect(a.packageHash).not.toBe(
      b.packageHash,
    );
  });

  it("changes package identity when channel changes", () => {
    const first = fixture();
    const second = fixture();

    second.intent.channelId =
      "UC" + "b".repeat(22);

    const a =
      createYoutubeDeliveryPackage(first);

    const b =
      createYoutubeDeliveryPackage(second);

    expect(a.packageHash).not.toBe(
      b.packageHash,
    );
  });

  it("enforces final description limits after chapters", () => {
    expect(() =>
      normalizeYoutubeMetadata(
        {
          title: "Test",
          description: "A".repeat(4980),
          categoryId: "28",
          chapters: [
            { startSeconds: 0, title: "Intro" },
            { startSeconds: 20, title: "Middle" },
            { startSeconds: 40, title: "End" },
          ],
        },
        60,
      ),
    ).toThrow(
      "M9 final description exceeds API limit",
    );
  });
});
