import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  PersistentVideoExportStore,
} from "./persistent-video-export.js";

import {
  createNativeVideoExportStage,
  VIDEO_EXPORT_STAGE_ID,
} from "./video-export-stage.js";

const H = "a".repeat(64);
const JOB = "m9-native-export-job";

function fixture() {
  const manifest = {
    releaseHash: H,
    exportHash: H,
    videoSha256: H,
    qaReportHash: H,
  };

  const run = vi.fn(async () => ({
    reused: false,
    manifest,
    directory: "/tmp/video-export",
  }));

  const validate = vi.fn(
    async () => true,
  );

  const loadVerifiedManifest =
    vi.fn(async () => manifest);

  const store = {
    run,
    validate,
    loadVerifiedManifest,
  } as unknown as PersistentVideoExportStore;

  return {
    run,
    validate,
    loadVerifiedManifest,
    stage: createNativeVideoExportStage(store),
  };
}

describe("M9.4 native export stage", () => {
  it("has an independent stage identity", () => {
    expect(VIDEO_EXPORT_STAGE_ID).toBe(
      "video_export",
    );
  });

  it("executes and returns a verified checkpoint", async () => {
    const test = fixture();

    const result =
      await test.stage.execute(JOB);

    expect(result.stageId).toBe(
      VIDEO_EXPORT_STAGE_ID,
    );

    expect(result.checkpoint).toEqual({
      version: 1,
      jobId: JOB,
      releaseHash: H,
      exportHash: H,
      videoSha256: H,
      qaReportHash: H,
    });

    expect(test.run).toHaveBeenCalledWith(
      JOB,
    );
  });

  it("rejects checkpoint verification failures", async () => {
    const test = fixture();

    test.validate.mockResolvedValue(false);

    await expect(
      test.stage.execute(JOB),
    ).rejects.toThrow(
      "M9 export checkpoint verification failed",
    );
  });

  it("rejects malformed checkpoints", async () => {
    const test = fixture();

    expect(
      await test.stage.validate(JOB, {}),
    ).toBe(false);

    expect(
      test.loadVerifiedManifest,
    ).not.toHaveBeenCalled();
  });

  it("rejects altered export identity", async () => {
    const test = fixture();

    const result =
      await test.stage.execute(JOB);

    expect(
      await test.stage.validate(
        JOB,
        {
          ...result.checkpoint,
          exportHash: "b".repeat(64),
        },
      ),
    ).toBe(false);
  });

  it("rejects missing committed exports", async () => {
    const test = fixture();

    test.loadVerifiedManifest.mockResolvedValue(
      null as never,
    );

    expect(
      await test.stage.validate(
        JOB,
        {
          version: 1,
          jobId: JOB,
          releaseHash: H,
          exportHash: H,
          videoSha256: H,
          qaReportHash: H,
        },
      ),
    ).toBe(false);
  });

  it("does not regenerate exports during validation", async () => {
    const test = fixture();

    await test.stage.validate(
      JOB,
      {
        version: 1,
        jobId: JOB,
        releaseHash: H,
        exportHash: H,
        videoSha256: H,
        qaReportHash: H,
      },
    );

    expect(test.run).not.toHaveBeenCalled();
    expect(test.validate).toHaveBeenCalledOnce();
  });
});
