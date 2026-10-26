import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createNativeRemotionVideoStage,
} from "./remotion-video-stage.js";

import type {
  PersistentRemotionVideoStore,
  RemotionVideoCheckpoint,
} from "./persistent-remotion-video.js";

const JOB_ID = "native-video-job";
const H = "a".repeat(64);

const checkpoint: RemotionVideoCheckpoint = {
  version: 1,
  jobId: JOB_ID,
  recordHash: H,
  videoSha256: H,
  compositionHash: H,
  captionPlanHash: H,
};

function fixture() {
  const run = vi.fn(async () => ({
    reused: false,
    checkpoint,
    record: {},
  }));

  const validate = vi.fn(async () => true);

  const stage = createNativeRemotionVideoStage({
    run,
    validate,
  } as unknown as PersistentRemotionVideoStore);

  return { stage, run, validate };
}

describe("M7 native video stage", () => {
  it("uses the independent video stage ID", () => {
    expect(fixture().stage.id).toBe("video");
  });

  it("executes and validates before reporting success", async () => {
    const test = fixture();

    const result = await test.stage.execute(JOB_ID);

    expect(result.stageId).toBe("video");
    expect(result.checkpoint).toEqual(checkpoint);
    expect(test.run).toHaveBeenCalledWith(JOB_ID);
    expect(test.validate).toHaveBeenCalledWith(
      JOB_ID,
      checkpoint,
    );
  });

  it("fails closed on invalid output checkpoints", async () => {
    const test = fixture();

    test.validate.mockResolvedValue(false);

    await expect(
      test.stage.execute(JOB_ID),
    ).rejects.toThrow(
      "M7 produced invalid video checkpoint",
    );
  });

  it("rejects malformed resume checkpoints", async () => {
    const test = fixture();

    expect(
      await test.stage.validate(JOB_ID, {}),
    ).toBe(false);

    expect(
      test.validate,
    ).not.toHaveBeenCalled();
  });
});
