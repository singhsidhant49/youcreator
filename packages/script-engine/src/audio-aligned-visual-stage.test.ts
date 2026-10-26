import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  AUDIO_ALIGNED_VISUAL_STAGE_ID,
  createNativeAudioAlignedVisualStage,
} from "./audio-aligned-visual-stage.js";

import type {
  AudioAlignedVisualCheckpoint,
  PersistentAudioAlignedVisualStore,
} from "./persistent-audio-aligned-visual.js";

const JOB_ID = "job-m6-native-stage";

function fixture() {
  const checkpoint: AudioAlignedVisualCheckpoint = {
    version: 1,
    jobId: JOB_ID,

    artifactPath:
      "/tmp/test/audio-aligned-visual.json",

    recordHash: "a".repeat(64),
    audioAlignedVisualHash: "b".repeat(64),

    m5VisualPackageHash: "c".repeat(64),
    framePlanHash: "d".repeat(64),
    audioSha256: "e".repeat(64),

    visualPackageHash: "f".repeat(64),

    totalFrames: 90,
    shotCount: 2,
  };

  const run = vi.fn(
    async (_jobId: string) => ({
      reused: false,
      checkpoint,
    }),
  );

  const validate = vi.fn(
    async (
      jobId: string,
      candidate: AudioAlignedVisualCheckpoint,
    ) =>
      jobId === JOB_ID &&
      JSON.stringify(candidate) ===
        JSON.stringify(checkpoint),
  );

  const store = {
    run,
    validate,
  } as unknown as PersistentAudioAlignedVisualStore;

  const stage =
    createNativeAudioAlignedVisualStage(store);

  return {
    checkpoint,
    run,
    validate,
    stage,
  };
}

describe("M6 native audio-aligned visual stage", () => {
  it("uses its own stage ID", () => {
    const { stage } = fixture();

    expect(stage.id).toBe(
      AUDIO_ALIGNED_VISUAL_STAGE_ID,
    );

    expect(stage.id).not.toBe("visual");
  });

  it("executes through immutable persistence", async () => {
    const test = fixture();

    const result = await test.stage.execute(
      JOB_ID,
    );

    expect(test.run).toHaveBeenCalledWith(
      JOB_ID,
    );

    expect(result).toEqual({
      stageId: AUDIO_ALIGNED_VISUAL_STAGE_ID,
      jobId: JOB_ID,
      reused: false,
      checkpoint: test.checkpoint,
    });
  });

  it("validates canonical checkpoint reuse", async () => {
    const test = fixture();

    expect(
      await test.stage.validate(
        JOB_ID,
        test.checkpoint,
      ),
    ).toBe(true);

    expect(
      test.validate,
    ).toHaveBeenCalledOnce();
  });

  it("rejects malformed checkpoints", async () => {
    const test = fixture();

    expect(
      await test.stage.validate(
        JOB_ID,
        {},
      ),
    ).toBe(false);

    expect(
      test.validate,
    ).not.toHaveBeenCalled();
  });

  it("rejects mismatched job IDs", async () => {
    const test = fixture();

    expect(
      await test.stage.validate(
        "another-job",
        test.checkpoint,
      ),
    ).toBe(false);
  });

  it("rejects invalid upstream checkpoints", async () => {
    const test = fixture();

    test.validate.mockResolvedValue(false);

    expect(
      await test.stage.validate(
        JOB_ID,
        test.checkpoint,
      ),
    ).toBe(false);
  });

  it("propagates execution failures", async () => {
    const test = fixture();

    test.run.mockRejectedValue(
      new Error("M6 narration WAV corrupted"),
    );

    await expect(
      test.stage.execute(JOB_ID),
    ).rejects.toThrow(
      "M6 narration WAV corrupted",
    );
  });

  it("fails closed on verification exceptions", async () => {
    const test = fixture();

    test.validate.mockRejectedValue(
      new Error("Media rights revoked"),
    );

    expect(
      await test.stage.validate(
        JOB_ID,
        test.checkpoint,
      ),
    ).toBe(false);
  });

  it("rejects empty job IDs", async () => {
    const test = fixture();

    await expect(
      test.stage.execute(""),
    ).rejects.toThrow(
      "Audio-aligned visual stage requires job ID",
    );

    expect(test.run).not.toHaveBeenCalled();
  });
});
