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
} from "vitest";

import {
  assertRenderedVideoMetadata,
} from "./remotion-output-verifier.js";

import {
  publishVerifiedMp4,
} from "./remotion-mp4-renderer.js";

const expected = {
  fps: 30,
  width: 1920,
  height: 1080,
  totalFrames: 90,
};

const valid = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationInSeconds: 3,
  codec: "h264",
  audioCodec: "aac",
};

describe("M7.5 MP4 output verification", () => {
  it("accepts valid H.264/AAC output", () => {
    expect(() =>
      assertRenderedVideoMetadata(
        valid,
        expected,
      ),
    ).not.toThrow();
  });

  it("rejects incorrect video codec", () => {
    expect(() =>
      assertRenderedVideoMetadata(
        {
          ...valid,
          codec: "vp9",
        },
        expected,
      ),
    ).toThrow(
      "M7 output codec mismatch",
    );
  });

  it("rejects missing AAC narration", () => {
    expect(() =>
      assertRenderedVideoMetadata(
        {
          ...valid,
          audioCodec: null,
        },
        expected,
      ),
    ).toThrow(
      "M7 output codec mismatch",
    );
  });

  it("rejects incorrect resolution", () => {
    expect(() =>
      assertRenderedVideoMetadata(
        {
          ...valid,
          width: 1280,
        },
        expected,
      ),
    ).toThrow(
      "M7 output resolution mismatch",
    );
  });

  it("rejects incorrect FPS", () => {
    expect(() =>
      assertRenderedVideoMetadata(
        {
          ...valid,
          fps: 24,
        },
        expected,
      ),
    ).toThrow(
      "M7 output FPS mismatch",
    );
  });

  it("rejects incorrect duration", () => {
    expect(() =>
      assertRenderedVideoMetadata(
        {
          ...valid,
          durationInSeconds: 4,
        },
        expected,
      ),
    ).toThrow(
      "M7 output duration mismatch",
    );
  });
});

describe("M7.5 create-only MP4 publication", () => {
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

  async function setup() {
    directory = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m7-mp4-",
      ),
    );

    const temporary = path.join(
      directory,
      "temporary.mp4",
    );

    const destination = path.join(
      directory,
      "final.mp4",
    );

    const bytes = Buffer.from(
      "test-mp4-publication-content",
    );

    await writeFile(
      temporary,
      bytes,
    );

    return {
      temporary,
      destination,
      bytes,
    };
  }

  it("publishes bytes without modification", async () => {
    const test = await setup();

    const size =
      await publishVerifiedMp4(
        test.temporary,
        test.destination,
      );

    expect(size).toBe(
      test.bytes.length,
    );

    expect(
      await readFile(
        test.destination,
      ),
    ).toEqual(test.bytes);
  });

  it("does not overwrite an existing MP4", async () => {
    const test = await setup();

    const original = Buffer.from(
      "original-video",
    );

    await writeFile(
      test.destination,
      original,
    );

    await expect(
      publishVerifiedMp4(
        test.temporary,
        test.destination,
      ),
    ).rejects.toThrow(
      "M7 final MP4 already exists",
    );

    expect(
      await readFile(test.destination),
    ).toEqual(original);
  });
});
