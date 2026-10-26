import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  createRemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import {
  createEditorialMotionPlan,
  type EditorialMotionPlan,
} from "./editorial-motion-plan.js";

import {
  createEditorialAudioPlan,
  type EditorialAudioPlan,
} from "./editorial-audio-plan.js";

import {
  PersistentRemotionVideoStore,
  getRemotionVideoPaths,
} from "./persistent-remotion-video.js";

const H = "a".repeat(64);
const JOB_ID = "m7-persistence-test";

function composition(): RemotionComposition {
  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId: JOB_ID,
    productionPackageHash: H,
    m6VisualHash: H,
    visualPackageHash: H,
    framePlanHash: H,
    scriptHash: H,
    alignmentHash: H,
    audioSha256: H,
    compositionHash: H,
    fps: 30,
    width: 1920,
    height: 1080,
    totalFrames: 30,
    shotCount: 1,
    audio: {
      format: "wav_pcm_s16le",
      path: "/tmp/narration.wav",
      sha256: H,
      sampleRate: 24000,
      sampleFrames: 24000,
      channels: 1,
      bitsPerSample: 16,
    },
    shots: [{
      version: 1,
      shotId: "shot-1",
      shotIndex: 0,
      bindingHash: H,
      assetSha256: H,
      assetId: "image-1",
      assetPath: "/tmp/image.png",
      sourceWidth: 1920,
      sourceHeight: 1080,
      startFrame: 0,
      endFrameExclusive: 30,
      durationFrames: 30,
      fit: "contain",
      motion: "static",
      startCrop: null,
      endCrop: null,
    }],
    words: [{
      tokenIndex: 0,
      index: 0,
      word: "Hello",
      text: "Hello",
      startSample: 0,
      endSampleExclusive: 12000,
      startSeconds: 0,
      endSeconds: 0.5,
    }],
  };
}

describe("M7.6 persistent video store", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
    directory = undefined;
  });

  async function fixture() {
    directory = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-m7-store-"),
    );

    let current = composition();
    let currentMotionPlan: EditorialMotionPlan | undefined = undefined;
    let currentAudioPlan: EditorialAudioPlan | undefined = undefined;

    const render = vi.fn(
      async ({ outputPath }: { outputPath: string }) => {
        await writeFile(
          outputPath,
          Buffer.from("verified-test-video"),
          { flag: "wx" },
        );
      },
    );

    const verify = vi.fn(async () => {});

    function store() {
      return new PersistentRemotionVideoStore({
        jobDirectory: () => directory!,
        sources: {
          async load() {
            return {
              manifest: current,
              captionPlan:
                createRemotionCaptionPlan(current),
              ...(currentMotionPlan
                ? { motionPlan: currentMotionPlan }
                : {}),
              ...(currentAudioPlan
                ? { audioPlan: currentAudioPlan }
                : {}),
            };
          },
        },
        renderer: {
          render: render as any,
        },
        verifier: { verify },
      });
    }

    return {
      store,
      render,
      verify,
      paths: getRemotionVideoPaths(
        directory,
        JOB_ID,
      ),
      changeComposition() {
        current = {
          ...current,
          compositionHash: "b".repeat(64),
        };
      },
      setMotionPlan(plan: EditorialMotionPlan | undefined) {
        currentMotionPlan = plan;
      },
      setAudioPlan(plan: EditorialAudioPlan | undefined) {
        currentAudioPlan = plan;
      },
    };
  }

  it("renders and persists a video record", async () => {
    const test = await fixture();

    const result = await test.store().run(JOB_ID);

    expect(result.reused).toBe(false);
    expect(result.record.videoBytes).toBeGreaterThan(0);
    expect(result.record.codec).toBe("h264");
    expect(result.record.audioCodec).toBe("aac");

    expect(test.render).toHaveBeenCalledOnce();
    expect(
      await readFile(test.paths.recordPath),
    ).toBeTruthy();
  });

  it("reuses identical video after restart", async () => {
    const test = await fixture();

    await test.store().run(JOB_ID);
    const second = await test.store().run(JOB_ID);

    expect(second.reused).toBe(true);
    expect(test.render).toHaveBeenCalledOnce();
  });

  it("validates a persisted checkpoint", async () => {
    const test = await fixture();

    const first = await test.store().run(JOB_ID);

    expect(
      await test.store().validate(
        JOB_ID,
        first.checkpoint,
      ),
    ).toBe(true);
  });

  it("rejects tampered MP4 bytes", async () => {
    const test = await fixture();

    await test.store().run(JOB_ID);

    await writeFile(
      test.paths.videoPath,
      Buffer.from("modified"),
    );

    await expect(
      test.store().run(JOB_ID),
    ).rejects.toThrow(
      "M7 persisted MP4 SHA-256 mismatch",
    );

    expect(test.render).toHaveBeenCalledOnce();
  });

  it("rejects changed composition identity", async () => {
    const test = await fixture();

    await test.store().run(JOB_ID);
    test.changeComposition();

    await expect(
      test.store().run(JOB_ID),
    ).rejects.toThrow(
      "M7 persisted video dependency mismatch",
    );

    expect(test.render).toHaveBeenCalledOnce();
  });

  it("fails closed on an orphaned MP4", async () => {
    const test = await fixture();

    const { mkdir } = await import(
      "node:fs/promises"
    );

    await mkdir(test.paths.directory, {
      recursive: true,
    });

    await writeFile(
      test.paths.videoPath,
      Buffer.from("orphan"),
    );

    await expect(
      test.store().run(JOB_ID),
    ).rejects.toThrow(
      "M7 uncommitted video artifact exists",
    );

    expect(test.render).not.toHaveBeenCalled();
  });

  it("rejects incorrect checkpoint ownership", async () => {
    const test = await fixture();

    const result = await test.store().run(JOB_ID);

    expect(
      await test.store().validate(
        JOB_ID,
        {
          ...result.checkpoint,
          jobId: "another-job",
        },
      ),
    ).toBe(false);
  });

  it("rejects changed motion plan identity", async () => {
    const test = await fixture();
    const motionPlanA = createEditorialMotionPlan({
      profile: "documentary",
      fps: 30,
      shots: [{
        shotId: "shot-1",
        assetSha256: H,
        startFrame: 0,
        endFrameExclusive: 30,
      }],
    });
    test.setMotionPlan(motionPlanA);

    const first = await test.store().run(JOB_ID);
    expect(first.record.motionPlanHash).toBe(motionPlanA.planHash);

    const motionPlanB = createEditorialMotionPlan({
      profile: "story",
      fps: 30,
      shots: [{
        shotId: "shot-1",
        assetSha256: H,
        startFrame: 0,
        endFrameExclusive: 30,
      }],
    });
    test.setMotionPlan(motionPlanB);

    await expect(
      test.store().run(JOB_ID),
    ).rejects.toThrow(
      "M7 persisted video dependency mismatch",
    );
  });

  it("rejects changed audio plan identity", async () => {
    const test = await fixture();
    const audioPlanA = createEditorialAudioPlan({
      version: 1,
      profile: "documentary",
      fps: 30,
      totalFrames: 30,
      narrationSha256: H,
      speechIntervals: [{
        startFrame: 0,
        endFrameExclusive: 20,
      }],
      music: null,
    });
    test.setAudioPlan(audioPlanA);

    const first = await test.store().run(JOB_ID);
    expect(first.record.editorialAudioPlanHash).toBe(audioPlanA.planHash);

    const audioPlanB = createEditorialAudioPlan({
      version: 1,
      profile: "story",
      fps: 30,
      totalFrames: 30,
      narrationSha256: H,
      speechIntervals: [{
        startFrame: 0,
        endFrameExclusive: 20,
      }],
      music: null,
    });
    test.setAudioPlan(audioPlanB);

    await expect(
      test.store().run(JOB_ID),
    ).rejects.toThrow(
      "M7 persisted video dependency mismatch",
    );
  });
});
