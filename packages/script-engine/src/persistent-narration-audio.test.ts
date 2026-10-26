import {
  mkdtemp,
  readFile,
  rm,
  unlink,
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

import {
  createNarrationAudio,
  parsePcmWav,
} from "./narration-audio-contract.js";

import {
  PersistentNarrationAudioStore,
} from "./persistent-narration-audio.js";

const JOB_ID = "job-m6-narration";

function wavFixture(
  sampleFrames = 24000,
  sampleRate = 24000,
  amplitude = 5000,
): Buffer {
  const dataBytes = sampleFrames * 2;

  const bytes = Buffer.alloc(
    44 + dataBytes,
  );

  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(
    bytes.length - 8,
    4,
  );

  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");

  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);  // PCM
  bytes.writeUInt16LE(1, 22);  // mono

  bytes.writeUInt32LE(
    sampleRate,
    24,
  );

  bytes.writeUInt32LE(
    sampleRate * 2,
    28,
  );

  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);

  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(
    dataBytes,
    40,
  );

  for (
    let index = 0;
    index < sampleFrames;
    index++
  ) {
    const value = Math.round(
      amplitude *
      Math.sin(
        (2 * Math.PI * 440 * index) /
        sampleRate,
      ),
    );

    bytes.writeInt16LE(
      value,
      44 + index * 2,
    );
  }

  return bytes;
}

describe("M6 narration contract and persistence", () => {
  let root: string | undefined;

  async function fixture() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m6-audio-",
      ),
    );

    const store =
      new PersistentNarrationAudioStore(
        (jobId) =>
          path.join(
            root!,
            "jobs",
            jobId,
          ),
      );

    return store;
  }

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = undefined;
    }
  });

  it("reads exact sample rate and duration", () => {
    const bytes = wavFixture(
      144000,
      24000,
    );

    const result =
      parsePcmWav(bytes);

    expect(result.sampleRate).toBe(24000);
    expect(result.sampleFrames).toBe(
      144000,
    );

    expect(result.durationSeconds).toBe(6);
  });

  it("produces a deterministic audio contract", () => {
    const bytes = wavFixture();

    const first = createNarrationAudio(
      JOB_ID,
      bytes,
    );

    const second = createNarrationAudio(
      JOB_ID,
      bytes,
    );

    expect(first).toEqual(second);
    expect(first.durationSeconds).toBe(1);

    expect(first.sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("persists and reuses identical audio", async () => {
    const store = await fixture();

    const bytes = wavFixture();

    const first = await store.save(
      JOB_ID,
      bytes,
    );

    const second = await store.save(
      JOB_ID,
      bytes,
    );

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);

    expect(second.record).toEqual(
      first.record,
    );

    expect(
      await readFile(
        first.paths.audioPath,
      ),
    ).toEqual(bytes);

    expect(
      await store.validate(
        JOB_ID,
        first.record.recordHash,
      ),
    ).toBe(true);
  });

  it("rejects conflicting audio replacement", async () => {
    const store = await fixture();

    await store.save(
      JOB_ID,
      wavFixture(24000),
    );

    await expect(
      store.save(
        JOB_ID,
        wavFixture(48000),
      ),
    ).rejects.toThrow(
      "Conflicting persisted narration",
    );
  });

  it("rejects truncated WAV and corrupted stored bytes", async () => {
    const store = await fixture();

    const valid = wavFixture();

    const truncated =
      valid.subarray(0, 44);

    expect(() =>
      parsePcmWav(truncated),
    ).toThrow(
      "WAV RIFF length mismatch",
    );

    const saved = await store.save(
      JOB_ID,
      valid,
    );

    await writeFile(
      saved.paths.audioPath,
      Buffer.from("corrupt-audio"),
    );

    expect(
      await store.validate(
        JOB_ID,
        saved.record.recordHash,
      ),
    ).toBe(false);

    await expect(
      store.load(JOB_ID),
    ).rejects.toThrow();
  });

  it("rejects incomplete narration publication", async () => {
    const store = await fixture();

    const saved = await store.save(
      JOB_ID,
      wavFixture(),
    );

    await unlink(
      saved.paths.recordPath,
    );

    await expect(
      store.load(JOB_ID),
    ).rejects.toThrow(
      "Incomplete persisted narration publication",
    );

    await expect(
      store.save(
        JOB_ID,
        wavFixture(),
      ),
    ).rejects.toThrow(
      "Incomplete persisted narration publication",
    );
  });
});
