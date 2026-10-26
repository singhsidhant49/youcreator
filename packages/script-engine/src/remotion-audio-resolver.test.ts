import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
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
} from "vitest";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  stageRemotionAudio,
  verifyRemotionWavBytes,
} from "./remotion-audio-resolver.js";

const HASH = "a".repeat(64);

function sha256(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

function makeWav(
  sampleFrames = 24001,
): Buffer {
  const wav = Buffer.alloc(
    44 + sampleFrames * 2,
  );

  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);

  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);

  wav.write("data", 36);
  wav.writeUInt32LE(sampleFrames * 2, 40);

  return wav;
}

describe("M7.3 verified narration WAV staging", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }

    root = undefined;
  });

  async function fixture() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m7-audio-",
      ),
    );

    const audioBytes = makeWav();

    const sourcePath = path.join(
      root,
      "narration.wav",
    );

    const publicDir = path.join(
      root,
      "remotion-public",
    );

    await writeFile(sourcePath, audioBytes);

    const audioSha = sha256(audioBytes);

    const manifest = {
      version: 1 as const,
      compositionId: "YouCreatorNarratedV1" as const,
      jobId: "job-m7-audio",

      productionPackageHash: HASH,
      m6VisualHash: HASH,
      visualPackageHash: HASH,
      framePlanHash: HASH,
      scriptHash: HASH,
      alignmentHash: HASH,
      audioSha256: audioSha,

      fps: 30,
      width: 1920,
      height: 1080,
      totalFrames: 31,
      shotCount: 1,

      audio: {
        format: "wav_pcm_s16le" as const,
        path: sourcePath,
        sha256: audioSha,
        sampleRate: 24000,
        sampleFrames: 24001,
        channels: 1 as const,
        bitsPerSample: 16 as const,
      },

      shots: [{
        version: 1 as const,
        shotId: "shot-001",
        shotIndex: 0,

        bindingHash: HASH,
        assetSha256: HASH,
        assetId: "asset-001",
        assetPath: path.join(
          root,
          "image.png",
        ),

        sourceWidth: 1920,
        sourceHeight: 1080,

        startFrame: 0,
        endFrameExclusive: 31,
        durationFrames: 31,

        fit: "contain" as const,
        motion: "static" as const,

        startCrop: null,
        endCrop: null,
      }],

      words: [{
        tokenIndex: 0,
        index: 0,
        word: "Hello",
        text: "Hello",
        startSample: 0,
        endSampleExclusive: 24000,
        startSeconds: 0,
        endSeconds: 1,
      }],

      compositionHash: HASH,
    } satisfies RemotionComposition;

    return {
      manifest,
      audioBytes,
      sourcePath,
      publicDir,
    };
  }

  it("stages verified WAV bytes", async () => {
    const test = await fixture();

    const staged = await stageRemotionAudio(
      test.manifest,
      test.publicDir,
    );

    expect(staged.audioUrl).toBe(
      `/media/${test.manifest.audio.sha256}.wav`,
    );

    const stagedPath = path.join(
      test.publicDir,
      staged.audioUrl.slice(1),
    );

    expect(
      await readFile(stagedPath),
    ).toEqual(test.audioBytes);
  });

  it("reuses an identical staged WAV", async () => {
    const test = await fixture();

    const first = await stageRemotionAudio(
      test.manifest,
      test.publicDir,
    );

    const second = await stageRemotionAudio(
      test.manifest,
      test.publicDir,
    );

    expect(second).toEqual(first);
  });

  it("rejects corrupted source bytes", async () => {
    const test = await fixture();

    const changed = Buffer.from(
      test.audioBytes,
    );

    changed[50] ^= 0xff;

    await writeFile(
      test.sourcePath,
      changed,
    );

    await expect(
      stageRemotionAudio(
        test.manifest,
        test.publicDir,
      ),
    ).rejects.toThrow(
      "M7 narration WAV SHA-256 mismatch",
    );
  });

  it("rejects incorrect sample metadata", async () => {
    const test = await fixture();

    expect(() =>
      verifyRemotionWavBytes(
        test.audioBytes,
        {
          ...test.manifest.audio,
          sampleFrames: 24000,
        },
      ),
    ).toThrow(
      "M7 narration WAV sample metadata mismatch",
    );
  });

  it("rejects an invalid PCM header", async () => {
    const test = await fixture();

    const changed = Buffer.from(
      test.audioBytes,
    );

    changed.writeUInt16LE(2, 22);

    expect(() =>
      verifyRemotionWavBytes(
        changed,
        test.manifest.audio,
      ),
    ).toThrow(
      "M7 narration WAV PCM structure invalid",
    );
  });

  it("rejects a corrupted existing staged file", async () => {
    const test = await fixture();

    const destination = path.join(
      test.publicDir,
      "media",
      `${test.manifest.audio.sha256}.wav`,
    );

    await mkdir(
      path.dirname(destination),
      { recursive: true },
    );

    await writeFile(
      destination,
      Buffer.from("corrupted"),
    );

    await expect(
      stageRemotionAudio(
        test.manifest,
        test.publicDir,
      ),
    ).rejects.toThrow(
      "M7 narration WAV header invalid",
    );
  });

  it("rejects a missing narration source", async () => {
    const test = await fixture();

    await rm(test.sourcePath);

    await expect(
      stageRemotionAudio(
        test.manifest,
        test.publicDir,
      ),
    ).rejects.toThrow();
  });
});
