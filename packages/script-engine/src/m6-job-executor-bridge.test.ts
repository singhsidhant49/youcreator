import { describe, expect, it, vi } from "vitest";

import {
  AUDIO_ALIGNED_VISUAL_STAGE_ID,
  type NativeAudioAlignedVisualStage,
} from "./audio-aligned-visual-stage.js";

import type {
  AudioAlignedVisualCheckpoint,
} from "./persistent-audio-aligned-visual.js";

import {
  createM6JobExecutorBridge,
} from "./m6-job-executor-bridge.js";

const JOB_ID = "job-m6-executor";

function fixture() {
  const checkpoint: AudioAlignedVisualCheckpoint = {
    version: 1,
    jobId: JOB_ID,
    artifactPath: "/tmp/m6/audio-aligned-visual.json",
    recordHash: "a".repeat(64),
    audioAlignedVisualHash: "b".repeat(64),
    m5VisualPackageHash: "c".repeat(64),
    framePlanHash: "d".repeat(64),
    audioSha256: "e".repeat(64),
    visualPackageHash: "f".repeat(64),
    totalFrames: 90,
    shotCount: 2,
  };

  const execute = vi.fn(async (jobId: string) => ({
    stageId: AUDIO_ALIGNED_VISUAL_STAGE_ID,
    jobId,
    reused: false,
    checkpoint,
  }));

  const validate = vi.fn(async (
    jobId: string,
    value: unknown,
  ) =>
    jobId === JOB_ID &&
    JSON.stringify(value) === JSON.stringify(checkpoint),
  );

  const stage: NativeAudioAlignedVisualStage = {
    id: AUDIO_ALIGNED_VISUAL_STAGE_ID,
    execute,
    validate,
  };

  return {
    checkpoint,
    execute,
    validate,
    bridge: createM6JobExecutorBridge(stage),
  };
}

describe("M6 JobExecutor bridge", () => {
  it("uses the independent audio-aligned stage ID", () => {
    const test = fixture();

    expect(test.bridge.id).toBe(
      "audio_aligned_visual",
    );
    expect(test.bridge.id).not.toBe("visual");
  });

  it("executes and validates before returning success", async () => {
    const test = fixture();

    const result = await test.bridge.execute({
      jobId: JOB_ID,
    });

    expect(result.checkpoint).toEqual(test.checkpoint);
    expect(result.reused).toBe(false);
    expect(test.execute).toHaveBeenCalledOnce();
    expect(test.validate).toHaveBeenCalledOnce();
  });

  it("rejects a checkpoint that fails validation", async () => {
    const test = fixture();
    test.validate.mockResolvedValue(false);

    await expect(
      test.bridge.execute({ jobId: JOB_ID }),
    ).rejects.toThrow(
      "M6 JobExecutor produced invalid checkpoint",
    );
  });

  it("rejects mismatched checkpoint ownership", async () => {
    const test = fixture();

    test.execute.mockResolvedValue({
      stageId: AUDIO_ALIGNED_VISUAL_STAGE_ID,
      jobId: JOB_ID,
      reused: false,
      checkpoint: {
        ...test.checkpoint,
        jobId: "different-job",
      },
    });

    await expect(
      test.bridge.execute({ jobId: JOB_ID }),
    ).rejects.toThrow(
      "M6 JobExecutor checkpoint job mismatch",
    );
  });

  it("validates a reusable checkpoint", async () => {
    const test = fixture();

    expect(
      await test.bridge.validate(
        { jobId: JOB_ID },
        test.checkpoint,
      ),
    ).toBe(true);
  });

  it("rejects malformed checkpoint reuse", async () => {
    const test = fixture();

    expect(
      await test.bridge.validate(
        { jobId: JOB_ID },
        { invalid: true },
      ),
    ).toBe(false);

    expect(test.validate).not.toHaveBeenCalled();
  });

  it("fails closed when upstream verification throws", async () => {
    const test = fixture();

    test.validate.mockRejectedValue(
      new Error("Media rights revoked"),
    );

    expect(
      await test.bridge.validate(
        { jobId: JOB_ID },
        test.checkpoint,
      ),
    ).toBe(false);
  });

  it("rejects empty job identity", async () => {
    const test = fixture();

    await expect(
      test.bridge.execute({ jobId: "" }),
    ).rejects.toThrow(
      "M6 JobExecutor requires job ID",
    );

    expect(test.execute).not.toHaveBeenCalled();
  });
});
