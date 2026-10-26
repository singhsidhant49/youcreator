import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  PersistentVideoQaStore,
  VideoQaCheckpoint,
} from "./persistent-video-qa.js";

import {
  createNativeVideoQaStage,
  VIDEO_QA_STAGE_ID,
} from "./video-qa-stage.js";

import {
  assertVideoPublishable,
} from "./native-video-qa.js";

const H = "a".repeat(64);
const JOB = "qa-stage-job";

const checkpoint: VideoQaCheckpoint = {
  version: 1,
  jobId: JOB,
  recordHash: H,
  reportHash: H,
  videoSha256: H,
  compositionHash: H,
  decision: "PASS",
};

function fixture() {
  const run = vi.fn(async () => ({
    reused: false,
    checkpoint,
    record: {},
  }));

  const validate = vi.fn(async () => true);

  const stage = createNativeVideoQaStage({
    run,
    validate,
  } as unknown as PersistentVideoQaStore);

  return { stage, run, validate };
}

describe("M8.7 native QA stage", () => {
  it("has an independent stage ID", () => {
    expect(VIDEO_QA_STAGE_ID).toBe(
      "quality_assurance",
    );
  });

  it("executes and validates before completion", async () => {
    const test = fixture();

    const result = await test.stage.execute(JOB);

    expect(result.stageId).toBe(VIDEO_QA_STAGE_ID);
    expect(result.checkpoint).toEqual(checkpoint);
    expect(test.validate).toHaveBeenCalledWith(
      JOB,
      checkpoint,
    );
  });

  it("rejects failed checkpoint verification", async () => {
    const test = fixture();

    test.validate.mockResolvedValue(false);

    await expect(
      test.stage.execute(JOB),
    ).rejects.toThrow(
      "M8 QA checkpoint failed verification",
    );
  });

  it("rejects malformed checkpoint reuse", async () => {
    const test = fixture();

    expect(
      await test.stage.validate(JOB, {}),
    ).toBe(false);

    expect(test.validate).not.toHaveBeenCalled();
  });

  it("allows only PASS for publication", () => {
    expect(() =>
      assertVideoPublishable("PASS"),
    ).not.toThrow();

    expect(() =>
      assertVideoPublishable("REVIEW"),
    ).toThrow("publication blocked: REVIEW");

    expect(() =>
      assertVideoPublishable("FAIL"),
    ).toThrow("publication blocked: FAIL");
  });
});
