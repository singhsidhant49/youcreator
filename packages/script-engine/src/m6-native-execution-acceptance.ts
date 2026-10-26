import {
  describe,
  expect,
  it,
} from "vitest";

import {
  AUDIO_ALIGNED_VISUAL_STAGE_ID,
} from "./audio-aligned-visual-stage.js";

import {
  AudioAlignedVisualCheckpointSchema,
  type AudioAlignedVisualCheckpoint,
} from "./persistent-audio-aligned-visual.js";

export interface M6AcceptanceRun {
  checkpoint: AudioAlignedVisualCheckpoint;
}

export interface M6AcceptanceDriver {
  /**
   * Execute the real M1 JobExecutor to completion.
   * Do not invoke the M6 stage directly.
   */
  execute(jobId: string): Promise<M6AcceptanceRun>;

  /**
   * Construct a NEW JobExecutor against the same
   * persisted stage/checkpoint directory.
   */
  restart(): Promise<M6AcceptanceDriver>;

  /**
   * Read the persisted M1 stage checkpoint.
   */
  readCheckpoint(
    jobId: string,
    stageId: typeof AUDIO_ALIGNED_VISUAL_STAGE_ID,
  ): Promise<unknown>;

  /**
   * Count actual Kokoro generation requests.
   */
  kokoroCallCount(): Promise<number>;

  /**
   * Count actual media acquisition requests.
   */
  mediaAcquisitionCount(): Promise<number>;

  /**
   * Read exact original M5 JSON bytes.
   */
  readM5Bytes(jobId: string): Promise<Buffer>;

  /**
   * Corrupt the already-published M6 artifact
   * without changing its checkpoint.
   */
  corruptM6Artifact(jobId: string): Promise<void>;

  /**
   * Remove a persisted stage checkpoint but
   * preserve all immutable artifacts.
   */
  removeM6Checkpoint(jobId: string): Promise<void>;

  /**
   * Restore pristine acceptance fixtures.
   * Each scenario must be independent.
   */
  prepare(scenario: string): Promise<string>;
}

export type M6AcceptanceDriverFactory =
  () => Promise<M6AcceptanceDriver>;

export function registerM6NativeExecutionAcceptance(
  createDriver: M6AcceptanceDriverFactory,
): void {
  describe("M6 real M1 execution acceptance", () => {
    it("executes and persists a valid M6 checkpoint", async () => {
      const driver = await createDriver();
      const jobId = await driver.prepare("fresh");

      const result = await driver.execute(jobId);

      expect(
        AudioAlignedVisualCheckpointSchema.parse(
          result.checkpoint,
        ).jobId,
      ).toBe(jobId);

      const persisted = await driver.readCheckpoint(
        jobId,
        AUDIO_ALIGNED_VISUAL_STAGE_ID,
      );

      expect(persisted).toEqual(result.checkpoint);
    });

    it("reuses verified outputs after executor restart", async () => {
      const driver = await createDriver();
      const jobId = await driver.prepare("restart");

      await driver.execute(jobId);

      const ttsBefore =
        await driver.kokoroCallCount();

      const mediaBefore =
        await driver.mediaAcquisitionCount();

      const restarted = await driver.restart();

      await restarted.execute(jobId);

      expect(
        await restarted.kokoroCallCount(),
      ).toBe(ttsBefore);

      expect(
        await restarted.mediaAcquisitionCount(),
      ).toBe(mediaBefore);
    });

    it("recovers a missing checkpoint without regenerating assets", async () => {
      const driver = await createDriver();
      const jobId = await driver.prepare("recovery");

      await driver.execute(jobId);

      const ttsBefore =
        await driver.kokoroCallCount();

      const mediaBefore =
        await driver.mediaAcquisitionCount();

      await driver.removeM6Checkpoint(jobId);

      const restarted = await driver.restart();
      const recovered = await restarted.execute(jobId);

      expect(
        recovered.checkpoint.jobId,
      ).toBe(jobId);

      expect(
        await restarted.kokoroCallCount(),
      ).toBe(ttsBefore);

      expect(
        await restarted.mediaAcquisitionCount(),
      ).toBe(mediaBefore);
    });

    it("rejects corrupted immutable M6 output", async () => {
      const driver = await createDriver();
      const jobId = await driver.prepare("corruption");

      await driver.execute(jobId);
      await driver.corruptM6Artifact(jobId);

      const restarted = await driver.restart();

      await expect(
        restarted.execute(jobId),
      ).rejects.toThrow();
    });

    it("preserves the original M5 artifact", async () => {
      const driver = await createDriver();
      const jobId = await driver.prepare("m5-immutable");

      const original =
        await driver.readM5Bytes(jobId);

      await driver.execute(jobId);

      const after =
        await driver.readM5Bytes(jobId);

      expect(after.equals(original)).toBe(true);
    });
  });
}
