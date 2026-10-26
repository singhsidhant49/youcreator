import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  extractVideoQaFrames,
} from "./video-qa-frame-extractor.js";

const ffmpegAvailable =
  spawnSync("ffmpeg", ["-version"], {
    stdio: "ignore",
  }).status === 0;

describe.skipIf(!ffmpegAvailable)(
  "M8.2 real FFmpeg extraction",
  () => {
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

    it("extracts exact requested decoded frame indices", async () => {
      directory = await mkdtemp(
        path.join(
          os.tmpdir(),
          "youcreator-m8-extract-",
        ),
      );

      const videoPath = path.join(
        directory,
        "three-frames.mp4",
      );

      const generated = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v", "error",
          "-f", "lavfi",
          "-i", "testsrc2=size=128x72:rate=1",
          "-frames:v", "3",
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          videoPath,
        ],
        { encoding: "utf8" },
      );

      expect(generated.status).toBe(0);

      const extracted =
        await extractVideoQaFrames(
          videoPath,
          [0, 2],
          { batchSize: 1 },
        );

      expect(
        extracted.map((frame) => frame.frame),
      ).toEqual([0, 2]);

      for (const frame of extracted) {
        const metadata = await sharp(
          frame.png,
        ).metadata();

        expect(metadata.width).toBe(128);
        expect(metadata.height).toBe(72);
        expect(metadata.format).toBe("png");
      }

      // The source filter produces different
      // imagery on frames zero and two.
      expect(
        extracted[0]!.png.equals(
          extracted[1]!.png,
        ),
      ).toBe(false);
    });
  },
);
